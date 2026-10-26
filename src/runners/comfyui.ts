import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Config } from "../config.js";
import { WorkerError } from "../errors.js";
import { EXT_BY_MIME } from "../inputs.js";
import type { InputStore } from "../inputs.js";
import { sleep } from "../util.js";
import type { RunContext, RunResult, Runner, RunnerProbe } from "./types.js";

const PRESETS = ["txt2img", "img2img", "upscale"] as const;

export const comfyParams = z
  .object({
    preset: z.enum(PRESETS),
    prompt: z.string().min(1).max(4000).optional(),
    negative_prompt: z.string().max(4000).optional(),
    width: z.number().int().min(64).max(2048).default(512),
    height: z.number().int().min(64).max(2048).default(512),
    steps: z.number().int().min(1).max(150).default(20),
    cfg: z.number().min(1).max(30).default(7),
    denoise: z.number().min(0).max(1).default(0.7).describe("Só para img2img."),
    seed: z.number().int().min(0).max(2 ** 32 - 1).optional(),
    batch: z.number().int().min(1).max(8).default(1),
    model: z.string().max(200).optional().describe("Checkpoint instalado. Se omitido, usa o padrão."),
    upscale_model: z.string().max(200).optional().describe("Modelo de upscale instalado (preset upscale)."),
    input_id: z.string().optional().describe("input_id da imagem (img2img e upscale)."),
  })
  .strict()
  .superRefine((v, ctx) => {
    if ((v.preset === "txt2img" || v.preset === "img2img") && !v.prompt) {
      ctx.addIssue({ code: "custom", path: ["prompt"], message: `prompt é obrigatório em ${v.preset}` });
    }
    if ((v.preset === "img2img" || v.preset === "upscale") && !v.input_id) {
      ctx.addIssue({ code: "custom", path: ["input_id"], message: `input_id é obrigatório em ${v.preset}` });
    }
  });

type ComfyParams = z.infer<typeof comfyParams>;

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

export class ComfyRunner implements Runner {
  type = "comfyui.generate";
  description =
    "Gera ou processa imagens com ComfyUI usando presets fixos (txt2img, img2img, upscale). Não aceita workflow cru.";
  paramsSchema = comfyParams;
  minVramMb = 4000;

  constructor(private cfg: Config) {}

  private get base(): string {
    return this.cfg.comfyui.url.replace(/\/+$/, "");
  }

  private async api(pathname: string, init?: RequestInit & { timeoutMs?: number }): Promise<Response> {
    const { timeoutMs = 15_000, ...rest } = init ?? {};
    return fetch(this.base + pathname, { ...rest, signal: rest.signal ?? AbortSignal.timeout(timeoutMs) });
  }

  private async listOptions(node: string, field: string): Promise<string[]> {
    const r = await this.api(`/object_info/${node}`, { timeoutMs: 5000 });
    if (!r.ok) return [];
    const j: any = await r.json();
    const opts = j?.[node]?.input?.required?.[field]?.[0];
    return Array.isArray(opts) ? opts.map(String) : [];
  }

  async probe(): Promise<RunnerProbe> {
    try {
      const [models, upscaleModels] = await Promise.all([
        this.listOptions("CheckpointLoaderSimple", "ckpt_name"),
        this.listOptions("UpscaleModelLoader", "model_name"),
      ]);
      const presets: string[] = [];
      if (models.length > 0) presets.push("txt2img", "img2img");
      if (upscaleModels.length > 0) presets.push("upscale");
      return {
        available: presets.length > 0,
        reason: presets.length === 0 ? "ComfyUI está no ar, mas sem checkpoints nem modelos de upscale instalados." : undefined,
        details: { presets, models, upscale_models: upscaleModels, default_model: this.cfg.comfyui.default_model ?? models[0] ?? null },
      };
    } catch (e: any) {
      return { available: false, reason: `ComfyUI inacessível em ${this.cfg.comfyui.url} (${e?.message ?? e})` };
    }
  }

  async precheck(raw: any, inputs: InputStore): Promise<void> {
    const p = raw as ComfyParams;
    const probe = await this.probe();
    if (!probe.available) throw new WorkerError("JOB_UNAVAILABLE", probe.reason ?? "ComfyUI indisponível.");
    const d: any = probe.details;
    if (!d.presets.includes(p.preset)) {
      throw new WorkerError("JOB_UNAVAILABLE", `Preset '${p.preset}' indisponível nesta máquina (faltam modelos).`);
    }
    if (p.preset !== "upscale") {
      const model = p.model ?? d.default_model;
      if (!model) throw new WorkerError("JOB_UNAVAILABLE", "Nenhum checkpoint instalado.");
      if (!d.models.includes(model)) {
        throw new WorkerError("JOB_UNAVAILABLE", `Modelo não instalado: ${model}. Disponíveis: ${d.models.join(", ")}`);
      }
    } else {
      const um = p.upscale_model ?? d.upscale_models[0];
      if (!d.upscale_models.includes(um)) {
        throw new WorkerError("JOB_UNAVAILABLE", `Modelo de upscale não instalado: ${um}.`);
      }
    }
    if (p.input_id) {
      const m = inputs.getReady(p.input_id);
      if (!m.mime?.startsWith("image/")) throw new WorkerError("INVALID_PARAMS", "input_id precisa ser uma imagem.");
    }
  }

  private buildWorkflow(p: ComfyParams, model: string | null, seed: number, imageName: string | null, upscaleModel: string | null) {
    if (p.preset === "upscale") {
      return {
        "1": { class_type: "LoadImage", inputs: { image: imageName } },
        "2": { class_type: "UpscaleModelLoader", inputs: { model_name: upscaleModel } },
        "3": { class_type: "ImageUpscaleWithModel", inputs: { upscale_model: ["2", 0], image: ["1", 0] } },
        "9": { class_type: "SaveImage", inputs: { filename_prefix: "gpuworker", images: ["3", 0] } },
      };
    }
    const wf: Record<string, any> = {
      "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: model } },
      "6": { class_type: "CLIPTextEncode", inputs: { text: p.prompt, clip: ["4", 1] } },
      "7": { class_type: "CLIPTextEncode", inputs: { text: p.negative_prompt ?? "", clip: ["4", 1] } },
      "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
      "9": { class_type: "SaveImage", inputs: { filename_prefix: "gpuworker", images: ["8", 0] } },
    };
    const ks: Record<string, any> = {
      seed,
      steps: p.steps,
      cfg: p.cfg,
      sampler_name: "euler",
      scheduler: "normal",
      model: ["4", 0],
      positive: ["6", 0],
      negative: ["7", 0],
    };
    if (p.preset === "txt2img") {
      wf["5"] = { class_type: "EmptyLatentImage", inputs: { width: p.width, height: p.height, batch_size: p.batch } };
      ks.denoise = 1;
      ks.latent_image = ["5", 0];
    } else {
      wf["10"] = { class_type: "LoadImage", inputs: { image: imageName } };
      wf["11"] = { class_type: "VAEEncode", inputs: { pixels: ["10", 0], vae: ["4", 2] } };
      ks.denoise = p.denoise;
      ks.latent_image = ["11", 0];
    }
    wf["3"] = { class_type: "KSampler", inputs: ks };
    return wf;
  }

  private async uploadImage(inputs: InputStore, inputId: string): Promise<string> {
    const meta = inputs.getReady(inputId);
    const ext = EXT_BY_MIME[meta.mime ?? ""] ?? "png";
    const buf = fs.readFileSync(inputs.blobPath(inputId));
    const form = new FormData();
    form.append("image", new Blob([buf], { type: meta.mime ?? "image/png" }), `gw_${inputId}.${ext}`);
    form.append("overwrite", "true");
    const r = await this.api("/upload/image", { method: "POST", body: form, timeoutMs: 60_000 });
    if (!r.ok) throw new WorkerError("RUNNER_ERROR", `ComfyUI recusou o upload da imagem (HTTP ${r.status}).`);
    const j: any = await r.json();
    return j.subfolder ? `${j.subfolder}/${j.name}` : String(j.name);
  }

  async run(ctx: RunContext): Promise<RunResult> {
    const p = ctx.params as ComfyParams;
    const probe = await this.probe();
    const d: any = probe.details ?? {};
    const model = p.preset === "upscale" ? null : (p.model ?? d.default_model ?? null);
    const upscaleModel = p.preset === "upscale" ? (p.upscale_model ?? d.upscale_models?.[0] ?? null) : null;
    const seed = p.seed ?? crypto.randomInt(0, 2 ** 32);

    let imageName: string | null = null;
    if (p.input_id) {
      ctx.log("enviando imagem de entrada ao ComfyUI");
      imageName = await this.uploadImage(ctx.inputs, p.input_id);
    }

    const workflow = this.buildWorkflow(p, model, seed, imageName, upscaleModel);
    const clientId = crypto.randomUUID();
    const sub = await this.api("/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: workflow, client_id: clientId }),
      timeoutMs: 30_000,
    });
    if (!sub.ok) {
      let detail = "";
      try {
        const j: any = await sub.json();
        detail = j?.error?.message ?? j?.error ?? "";
        if (typeof detail !== "string") detail = JSON.stringify(detail);
      } catch {
        /* sem corpo */
      }
      throw new WorkerError("RUNNER_ERROR", `ComfyUI recusou o workflow (HTTP ${sub.status}) ${detail}`.trim());
    }
    const { prompt_id } = (await sub.json()) as { prompt_id: string };
    ctx.log(`prompt enviado ao ComfyUI (${prompt_id.slice(0, 8)})`);
    ctx.progress(0.05);

    const stopWs = this.watchProgress(clientId, prompt_id, ctx);
    const onAbort = () => {
      this.api("/interrupt", { method: "POST", timeoutMs: 5000 }).catch(() => {});
      this.api("/queue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ delete: [prompt_id] }),
        timeoutMs: 5000,
      }).catch(() => {});
    };
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    try {
      let entry: any = null;
      while (!entry) {
        if (ctx.signal.aborted) throw new WorkerError("CANCELLED", "Job interrompido.");
        await sleep(800);
        const r = await this.api(`/history/${prompt_id}`, { timeoutMs: 10_000 });
        if (!r.ok) continue;
        const h: any = await r.json();
        const e = h?.[prompt_id];
        if (e && (e.status?.completed || e.status?.status_str === "error" || e.outputs)) entry = e;
      }
      if (entry.status?.status_str === "error") {
        const msgs = (entry.status?.messages ?? []).filter((m: any) => m?.[0] === "execution_error");
        const detail = msgs[0]?.[1]?.exception_message ?? "erro durante a execução";
        throw new WorkerError("RUNNER_ERROR", `ComfyUI: ${String(detail).slice(0, 300)}`);
      }

      const files: RunResult["files"] = [];
      let idx = 0;
      for (const node of Object.values<any>(entry.outputs ?? {})) {
        for (const img of node?.images ?? []) {
          if (img.type === "temp") continue;
          const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder ?? "", type: img.type ?? "output" });
          const r = await this.api(`/view?${q}`, { timeoutMs: 60_000 });
          if (!r.ok) throw new WorkerError("RUNNER_ERROR", `Falha ao buscar a imagem gerada (HTTP ${r.status}).`);
          const ext = (path.extname(img.filename).slice(1) || "png").toLowerCase();
          idx++;
          const name = `out_${String(idx).padStart(4, "0")}.${ext}`;
          fs.writeFileSync(path.join(ctx.outDir, name), Buffer.from(await r.arrayBuffer()));
          files.push({ name, mime: MIME_BY_EXT[ext] ?? "application/octet-stream" });
        }
      }
      if (files.length === 0) throw new WorkerError("RUNNER_ERROR", "ComfyUI terminou sem gerar imagens.");
      ctx.progress(1);
      return { files, metadata: { model: model ?? upscaleModel ?? undefined, seed } };
    } finally {
      ctx.signal.removeEventListener("abort", onAbort);
      stopWs();
    }
  }

  /** Progresso via WebSocket do ComfyUI (best-effort; se não houver WebSocket, o polling segue valendo). */
  private watchProgress(clientId: string, promptId: string, ctx: RunContext): () => void {
    const WS = (globalThis as any).WebSocket;
    if (!WS) return () => {};
    let ws: any;
    try {
      ws = new WS(`${this.base.replace(/^http/, "ws")}/ws?clientId=${clientId}`);
      ws.onmessage = (ev: any) => {
        if (typeof ev.data !== "string") return;
        try {
          const m = JSON.parse(ev.data);
          if (m.type === "progress" && m.data?.prompt_id === promptId && m.data.max > 0) {
            ctx.progress(0.05 + 0.9 * (m.data.value / m.data.max));
          }
        } catch {
          /* ignora */
        }
      };
      ws.onerror = () => {};
    } catch {
      return () => {};
    }
    return () => {
      try {
        ws.close();
      } catch {
        /* ignora */
      }
    };
  }
}
