// Teste de fumaça ponta a ponta, como um agente remoto faria.
// Uso: GW_URL=http://IP:8787/mcp GW_TOKEN=gw_... npm run smoke
// Opções (env): GW_STEPS (padrão 8), GW_TIMEOUT_S (padrão 600), GW_SKIP=upload,cancel,ssrf, GW_FETCH_URL=<url de imagem pública>
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const URL_ = process.env.GW_URL;
const TOKEN = process.env.GW_TOKEN;
if (!URL_ || !TOKEN) {
  console.error("Defina GW_URL (ex: http://100.x.y.z:8787/mcp) e GW_TOKEN.");
  process.exit(2);
}
const STEPS = Number(process.env.GW_STEPS ?? 8);
const TIMEOUT_MS = Number(process.env.GW_TIMEOUT_S ?? 600) * 1000;
const SKIP = new Set((process.env.GW_SKIP ?? "").split(",").filter(Boolean));
const OUT = path.resolve("smoke-out");
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const record = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "[ok]  " : "[FALHOU]"} ${name}${detail ? " — " + detail : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const client = new Client({ name: "gpu-worker-smoke", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(URL_), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));

async function tool(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "{}";
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { isError: !!r.isError, data };
}

async function waitJob(id, label) {
  const start = Date.now();
  let last = "";
  for (;;) {
    const { data } = await tool("get_job", { job_id: id });
    const line = `${data.status} ${Math.round((data.progress ?? 0) * 100)}%`;
    if (line !== last) console.log(`      ${label}: ${line}`);
    last = line;
    if (["done", "failed", "cancelled"].includes(data.status)) return data;
    if (Date.now() - start > TIMEOUT_MS) throw new Error("tempo esgotado esperando o job");
    await sleep(1000);
  }
}

async function download(file) {
  const r = await fetch(file.url);
  if (!r.ok) throw new Error(`download HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const sha = crypto.createHash("sha256").update(buf).digest("hex");
  fs.writeFileSync(path.join(OUT, file.name), buf);
  return { buf, shaOk: sha === file.sha256 };
}

try {
  // 1. capabilities
  const caps = (await tool("list_capabilities")).data;
  const comfy = caps.jobs?.find((j) => j.type === "comfyui.generate");
  console.log(`      GPU: ${caps.gpu ? `${caps.gpu.name} (${caps.gpu.vram_total_mb} MB)` : "não detectada"}; status: ${caps.status}`);
  record("list_capabilities", !!comfy, comfy ? `presets: ${(comfy.presets ?? []).join(", ") || "nenhum"}` : "job comfyui.generate ausente");
  if (!comfy?.available) {
    record("ComfyUI disponível", false, comfy?.reason ?? "");
    throw new Error("ComfyUI indisponível; veja 'gpu-worker doctor'");
  }

  // 2. txt2img + download
  const sub = await tool("submit_job", {
    type: "comfyui.generate",
    params: { preset: "txt2img", prompt: "a small red cube on a wooden table, studio light", width: 512, height: 512, steps: STEPS, seed: 42 },
  });
  record("submit_job txt2img", !sub.isError && !!sub.data.job_id, sub.isError ? JSON.stringify(sub.data) : sub.data.job_id);
  const job = await waitJob(sub.data.job_id, "txt2img");
  record("txt2img concluído", job.status === "done", job.error ? `${job.error.code}: ${job.error.message}` : `${job.metadata?.duration_s}s, modelo ${job.metadata?.model}`);
  const file = job.output?.files?.[0];
  let firstImage = null;
  if (file) {
    const d = await download(file);
    firstImage = d.buf;
    record("download via URL temporária", d.buf.subarray(1, 4).toString() === "PNG" && d.shaOk, `${file.name}, ${file.size} bytes, salvo em smoke-out/`);
  } else record("download via URL temporária", false, "sem arquivo de saída");

  // 3. upload + img2img
  if (!SKIP.has("upload") && firstImage) {
    const up = await tool("create_upload", { name: "entrada.png", size: firstImage.length });
    const put = await fetch(up.data.upload.url, { method: "PUT", body: firstImage, headers: { "content-type": "application/octet-stream" } });
    record("create_upload + PUT", put.status === 201, `HTTP ${put.status}`);
    if (put.status === 201 && (comfy.presets ?? []).includes("img2img")) {
      const s2 = await tool("submit_job", {
        type: "comfyui.generate",
        params: { preset: "img2img", prompt: "same scene, blue cube", input_id: up.data.input_id, steps: STEPS, denoise: 0.6, seed: 7 },
      });
      const j2 = await waitJob(s2.data.job_id, "img2img");
      record("img2img com input enviado", j2.status === "done", j2.error ? `${j2.error.code}: ${j2.error.message}` : `${j2.metadata?.duration_s}s`);
      if (j2.output?.files?.[0]) await download(j2.output.files[0]);
    }
    // arquivo que não é imagem deve ser rejeitado pelo conteúdo
    const bad = await tool("create_upload", { name: "falso.png", size: 11 });
    const putBad = await fetch(bad.data.upload.url, { method: "PUT", body: "hello world" });
    record("upload de tipo inválido rejeitado (415)", putBad.status === 415, `HTTP ${putBad.status}`);
  }

  // 4. fetch_input (opcional) e SSRF
  if (process.env.GW_FETCH_URL) {
    const f = await tool("fetch_input", { url: process.env.GW_FETCH_URL });
    record("fetch_input", !f.isError && !!f.data.input_id, f.isError ? JSON.stringify(f.data) : `${f.data.mime}, ${f.data.size} bytes`);
  }
  if (!SKIP.has("ssrf")) {
    const s = await tool("fetch_input", { url: "http://127.0.0.1:1/x.png" });
    record("fetch_input bloqueia endereço interno", s.isError && s.data.error?.code === "INPUT_REJECTED", s.data.error?.message ?? "");
  }

  // 5. erro de parâmetros
  const inv = await tool("submit_job", { type: "comfyui.generate", params: { preset: "txt2img" } });
  record("params inválidos → INVALID_PARAMS", inv.isError && inv.data.error?.code === "INVALID_PARAMS", inv.data.error?.message ?? "");

  // 6. cancelamento
  if (!SKIP.has("cancel")) {
    const c = await tool("submit_job", {
      type: "comfyui.generate",
      params: { preset: "txt2img", prompt: "cancel test", width: 768, height: 768, steps: 100 },
    });
    await sleep(1500);
    await tool("cancel_job", { job_id: c.data.job_id });
    const cj = await waitJob(c.data.job_id, "cancel");
    record("cancel_job", cj.status === "cancelled", cj.error?.code ?? "");
  }

  // 7. autenticação
  const bad = await fetch(URL_, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer errado" }, body: "{}" });
  record("token inválido → 401", bad.status === 401, `HTTP ${bad.status}`);
} catch (e) {
  record("execução do smoke", false, e.message);
} finally {
  await client.close().catch(() => {});
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${failed === 0 ? "TUDO OK" : `${failed} verificação(ões) falharam`} (${results.length - failed}/${results.length})`);
process.exit(failed ? 1 : 0);
