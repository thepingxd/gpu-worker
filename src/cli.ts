#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import {
  DEFAULTS,
  configExists,
  configPath,
  hashToken,
  homeDir,
  loadConfig,
  newToken,
  saveConfig,
  type Config,
} from "./config.js";
import { detectGpu } from "./gpu.js";
import { App } from "./app.js";
import { createHttpServer } from "./server.js";
import { resolveBind, tailscaleIp } from "./tailscale.js";
import { nowIso, log } from "./util.js";
import { VERSION } from "./version.js";

const args = process.argv.slice(2);
const cmd = args[0];

function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
const has = (name: string) => args.includes(`--${name}`);

const HELP = `gpu-worker ${VERSION}

Uso:
  gpu-worker init [--bind tailscale|IP] [--port N] [--comfyui URL] [--force]
  gpu-worker start
  gpu-worker doctor
  gpu-worker token add <nome> | list | revoke <nome>

Config e dados ficam em ${homeDir()} (mude com GPU_WORKER_HOME).`;

async function init() {
  if (configExists() && !has("force")) {
    console.log(`Já existe config em ${configPath()}.`);
    console.log("Para criar outro token: gpu-worker token add <nome>. Para recriar tudo: gpu-worker init --force");
    return;
  }
  const ts = await tailscaleIp();
  const bind = flag("bind") ?? (ts ? "tailscale" : "127.0.0.1");
  const port = Number(flag("port") ?? DEFAULTS.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Porta inválida.");
  const token = newToken();
  const cfg: Config = {
    ...structuredClone(DEFAULTS),
    bind,
    port,
    tokens: [{ name: "default", hash: hashToken(token), created_at: nowIso() }],
    signing_secret: crypto.randomBytes(32).toString("hex"),
  };
  const comfy = flag("comfyui");
  if (comfy) cfg.comfyui.url = comfy;
  fs.mkdirSync(homeDir(), { recursive: true, mode: 0o700 });
  saveConfig(cfg);

  const host = bind === "tailscale" ? (ts ?? "<ip-da-tailnet>") : bind;
  console.log(`gpu-worker configurado.

  config:  ${configPath()}
  bind:    ${bind === "tailscale" ? `tailscale (${host})` : bind}${bind === "127.0.0.1" ? "  <- só acessível nesta máquina" : ""}
  porta:   ${port}
  ComfyUI: ${cfg.comfyui.url}

Token (guarde agora; não será mostrado de novo):
  ${token}

Próximos passos:
  1. Suba o ComfyUI (${cfg.comfyui.url}) com ao menos um checkpoint.
  2. gpu-worker doctor
  3. gpu-worker start
  4. Em outro terminal (no repo): GW_URL=http://${host}:${port}/mcp GW_TOKEN=${token} npm run smoke
`);
  if (!ts && bind === "127.0.0.1") {
    console.log("Tailscale não detectado: configurado só para teste local. Para acesso remoto, instale o Tailscale e rode: gpu-worker init --force --bind tailscale\n");
  }
}

async function start() {
  const cfg = loadConfig();
  const host = await resolveBind(cfg.bind);
  if (!net.isIP(host)) throw new Error(`bind inválido: ${host}`);
  if (cfg.fetch.allow_private_addresses) log("AVISO: fetch.allow_private_addresses=true (proteção anti-SSRF desligada; use só em testes)");
  const app = new App(cfg, host);
  const server = createHttpServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.port, host, resolve);
  });
  const gpu = await detectGpu(0);
  log(`gpu-worker ${VERSION} ouvindo em ${app.baseUrl}  (MCP: ${app.baseUrl}/mcp)`);
  log(gpu ? `GPU: ${gpu.name}, ${gpu.vram_total_mb} MB de VRAM, driver ${gpu.driver}` : "GPU NVIDIA não detectada (nvidia-smi); jobs seguem sem checagem de VRAM");
  for (const r of app.runners) {
    const p = await r.probe();
    log(`${r.type}: ${p.available ? "disponível" : "indisponível — " + p.reason}`);
  }
  app.jobs.resume();
  const c = app.cleanup();
  if (c.inputs || c.jobs) log(`limpeza: ${c.inputs} inputs e ${c.jobs} jobs antigos removidos`);
  const timer = setInterval(() => app.cleanup(), 3600_000);
  timer.unref();

  const stop = async () => {
    log("encerrando...");
    server.close();
    await app.jobs.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

async function doctor() {
  let bad = 0;
  const line = (ok: boolean | null, label: string, detail = "") => {
    if (ok === false) bad++;
    console.log(`${ok === true ? "[ok]  " : ok === false ? "[ERRO]" : "[aviso]"} ${label}${detail ? " — " + detail : ""}`);
  };
  const major = Number(process.versions.node.split(".")[0]);
  line(major >= 20, "Node.js", process.versions.node + (major < 20 ? " (precisa de 20+)" : ""));
  if (!configExists()) {
    line(false, "Config", `não encontrada em ${configPath()}; rode gpu-worker init`);
    process.exitCode = 1;
    return;
  }
  const cfg = loadConfig();
  line(true, "Config", configPath());
  const gpu = await detectGpu(0);
  line(gpu ? true : null, "GPU NVIDIA", gpu ? `${gpu.name}, ${gpu.vram_total_mb} MB, driver ${gpu.driver}` : "nvidia-smi não encontrado ou sem GPU");
  try {
    const host = await resolveBind(cfg.bind);
    line(true, "Endereço de bind", `${host}:${cfg.port}`);
  } catch (e: any) {
    line(false, "Endereço de bind", e.message);
  }
  if (cfg.comfyui.enabled) {
    const { ComfyRunner } = await import("./runners/comfyui.js");
    const probe = await new ComfyRunner(cfg).probe();
    line(probe.available, "ComfyUI", probe.available ? `${cfg.comfyui.url} — ${(probe.details as any).models.length} checkpoint(s), presets: ${(probe.details as any).presets.join(", ")}` : probe.reason ?? "");
  }
  if (bad) process.exitCode = 1;
}

function token() {
  const cfg = loadConfig();
  const sub = args[1];
  const name = args[2];
  if (sub === "add") {
    if (!name || !/^[\w.-]{1,40}$/.test(name)) throw new Error("Informe um nome (letras, números, . _ -).");
    if (cfg.tokens.some((t) => t.name === name)) throw new Error(`Já existe um token chamado ${name}.`);
    const t = newToken();
    cfg.tokens.push({ name, hash: hashToken(t), created_at: nowIso() });
    saveConfig(cfg);
    console.log(`Token '${name}' criado (guarde agora; não será mostrado de novo):\n  ${t}`);
  } else if (sub === "list") {
    for (const t of cfg.tokens) console.log(`${t.name}\t${t.created_at}`);
  } else if (sub === "revoke") {
    const before = cfg.tokens.length;
    cfg.tokens = cfg.tokens.filter((t) => t.name !== name);
    if (cfg.tokens.length === before) throw new Error(`Token não encontrado: ${name}`);
    saveConfig(cfg);
    console.log(`Token '${name}' revogado (vale em até ~5s no daemon em execução).`);
  } else {
    console.log("Uso: gpu-worker token add <nome> | list | revoke <nome>");
  }
}

try {
  if (cmd === "init") await init();
  else if (cmd === "start") await start();
  else if (cmd === "doctor") await doctor();
  else if (cmd === "token") token();
  else console.log(HELP);
} catch (e: any) {
  console.error(`Erro: ${e?.message ?? e}`);
  process.exit(1);
}
