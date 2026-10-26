import fs from "node:fs";
import { z } from "zod";
import { configPath, dataDir, type Config, type TokenEntry } from "./config.js";
import { configureGpu, detectGpuReport } from "./gpu.js";
import { InputStore, type InputMeta } from "./inputs.js";
import { JobManager, type Job } from "./jobs.js";
import { KeepAwake, getPowerState } from "./power.js";
import { ComfyRunner } from "./runners/comfyui.js";
import type { Runner } from "./runners/types.js";
import { sign } from "./signing.js";
import { VERSION } from "./version.js";

export class App {
  inputs: InputStore;
  jobs: JobManager;
  keepAwake: KeepAwake;
  runners: Runner[] = [];
  baseUrl: string;
  private tokenCache: { at: number; tokens: TokenEntry[] };

  constructor(
    public cfg: Config,
    host: string,
  ) {
    const data = dataDir();
    fs.mkdirSync(data, { recursive: true });
    this.baseUrl = (cfg.public_url ?? `http://${host.includes(":") ? `[${host}]` : host}:${cfg.port}`).replace(/\/+$/, "");
    configureGpu({ comfyuiUrl: cfg.comfyui.enabled ? cfg.comfyui.url : null });
    if (cfg.comfyui.enabled) this.runners.push(new ComfyRunner(cfg));
    this.inputs = new InputStore(cfg, data);
    this.keepAwake = new KeepAwake(cfg.power.keep_awake);
    this.jobs = new JobManager(cfg, data, this.runners, this.inputs, this.keepAwake);
    this.tokenCache = { at: Date.now(), tokens: cfg.tokens };
  }

  /** Tokens recarregados do disco a cada ~5s, para `token add/revoke` valer sem reiniciar. */
  tokens(maxAgeMs = 5000): TokenEntry[] {
    if (Date.now() - this.tokenCache.at > maxAgeMs) {
      try {
        const raw = JSON.parse(fs.readFileSync(configPath(), "utf8"));
        this.tokenCache = { at: Date.now(), tokens: raw.tokens ?? [] };
      } catch {
        this.tokenCache.at = Date.now();
      }
    }
    return this.tokenCache.tokens;
  }

  signedUrl(method: "GET" | "PUT", urlPath: string, ttlS: number): { url: string; expires_at: string } {
    const exp = Math.floor(Date.now() / 1000) + ttlS;
    const sig = sign(this.cfg.signing_secret, method, urlPath, exp);
    return { url: `${this.baseUrl}${urlPath}?exp=${exp}&sig=${sig}`, expires_at: new Date(exp * 1000).toISOString() };
  }

  uploadUrl(inputId: string) {
    return this.signedUrl("PUT", `/upload/${inputId}`, this.cfg.limits.upload_url_ttl_s);
  }

  jobView(job: Job) {
    const files =
      job.status === "done"
        ? job.files
            .filter((f) => this.jobs.outputPath(job, f.name))
            .map((f) => ({
              name: f.name,
              mime: f.mime,
              size: f.size,
              sha256: f.sha256,
              ...this.signedUrl("GET", `/download/${job.id}/${encodeURIComponent(f.name)}`, this.cfg.limits.download_url_ttl_s),
            }))
        : [];
    return {
      job_id: job.id,
      type: job.type,
      status: job.status,
      progress: Math.round(job.progress * 100) / 100,
      output: { files },
      metadata: job.metadata,
      error: job.error,
      logs_tail: job.logs,
      created_at: job.created_at,
      started_at: job.started_at ?? null,
      finished_at: job.finished_at ?? null,
    };
  }

  inputView(m: InputMeta) {
    return {
      input_id: m.id,
      name: m.name,
      mime: m.mime,
      size: m.state === "ready" ? m.size : (m.declared_size ?? 0),
      sha256: m.sha256,
      state: m.state,
      pinned: m.pinned,
      expires_at: m.expires_at,
    };
  }

  async capabilities() {
    const { gpu, warnings: gpuWarnings } = await detectGpuReport(0);
    const power = await getPowerState();
    const warnings = [...gpuWarnings];
    if (power.on_battery) {
      warnings.push(
        `A máquina está na bateria${power.percent !== null ? ` (${power.percent}%)` : ""}. Jobs longos podem ser limitados pelo sistema; ${this.cfg.power.on_battery === "block" ? "novos jobs são recusados" : `jobs são recusados abaixo de ${this.cfg.power.min_battery_percent}%`}.`,
      );
    }
    const jobs = [];
    for (const r of this.runners) {
      const probe = await r.probe();
      jobs.push({
        type: r.type,
        description: r.description,
        available: probe.available,
        reason: probe.reason,
        min_vram_mb: r.minVramMb,
        ...probe.details,
        params_schema: z.toJSONSchema(r.paramsSchema, { io: "input", unrepresentable: "any" }),
      });
    }
    return {
      name: "gpu-worker",
      version: VERSION,
      gpu,
      warnings,
      power: {
        has_battery: power.has_battery,
        on_battery: power.on_battery,
        battery_percent: power.percent,
        policy: this.cfg.power.on_battery,
        min_battery_percent: this.cfg.power.min_battery_percent,
        keep_awake: this.cfg.power.keep_awake,
      },
      status: this.jobs.isBusy() ? "busy" : "idle",
      queue_length: this.jobs.queueLength(),
      limits: {
        max_input_mb: this.cfg.limits.max_input_mb,
        max_output_mb: this.cfg.limits.max_output_mb,
        default_timeout_s: this.cfg.limits.default_timeout_s,
        max_timeout_s: this.cfg.limits.max_timeout_s,
        max_queue: this.cfg.limits.max_queue,
      },
      accepted_input_types: ["image/png", "image/jpeg", "image/webp", "image/gif", "application/x-blender"],
      jobs,
    };
  }

  cleanup(): { inputs: number; jobs: number } {
    return { inputs: this.inputs.cleanup(), jobs: this.jobs.cleanup() };
  }
}

