import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicWriteFile } from "./util.js";

export interface TokenEntry {
  name: string;
  hash: string;
  created_at: string;
}

export interface Config {
  /** "tailscale" (resolve o IP da tailnet) ou um IP explícito. Nunca 0.0.0.0. */
  bind: string;
  port: number;
  /** URL base usada nos links assinados. Se null, usa http://<bind>:<port>. */
  public_url: string | null;
  /** Quanto esperar (s) o Tailscale conectar ao iniciar, antes de desistir. Só vale com bind "tailscale". */
  tailscale_wait_s: number;
  tokens: TokenEntry[];
  signing_secret: string;
  power: {
    /** "block" recusa jobs enquanto a máquina estiver na bateria. */
    on_battery: "allow" | "block";
    /** Na bateria, recusa jobs abaixo desta carga (%). 0 desliga. */
    min_battery_percent: number;
    /** Impede a suspensão por inatividade enquanto há job rodando. */
    keep_awake: boolean;
  };
  comfyui: { enabled: boolean; url: string; default_model: string | null };
  limits: {
    max_input_mb: number;
    inputs_quota_mb: number;
    max_output_mb: number;
    max_queue: number;
    default_timeout_s: number;
    max_timeout_s: number;
    ttl_hours: number;
    rate_limit_per_min: number;
    download_url_ttl_s: number;
    upload_url_ttl_s: number;
  };
  fetch: {
    /** Vazio = qualquer host público. Entradas casam com o host exato ou subdomínios. */
    allowlist: string[];
    max_redirects: number;
    /** Só para testes locais. Desliga a proteção anti-SSRF. */
    allow_private_addresses: boolean;
    timeout_s: number;
  };
}

export const DEFAULTS: Omit<Config, "tokens" | "signing_secret"> = {
  bind: "tailscale",
  port: 8787,
  public_url: null,
  tailscale_wait_s: 120,
  power: { on_battery: "allow", min_battery_percent: 20, keep_awake: true },
  comfyui: { enabled: true, url: "http://127.0.0.1:8188", default_model: null },
  limits: {
    max_input_mb: 512,
    inputs_quota_mb: 4096,
    max_output_mb: 2048,
    max_queue: 20,
    default_timeout_s: 600,
    max_timeout_s: 3600,
    ttl_hours: 24,
    rate_limit_per_min: 600,
    download_url_ttl_s: 900,
    upload_url_ttl_s: 900,
  },
  fetch: { allowlist: [], max_redirects: 3, allow_private_addresses: false, timeout_s: 600 },
};

export function homeDir(): string {
  return process.env.GPU_WORKER_HOME ?? path.join(os.homedir(), ".gpu-worker");
}
export const configPath = () => path.join(homeDir(), "config.json");
export const dataDir = () => path.join(homeDir(), "data");

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function newToken(): string {
  return "gw_" + crypto.randomBytes(24).toString("base64url");
}

function merge<T>(base: T, over: any): T {
  if (over === undefined || over === null) return base;
  if (typeof base !== "object" || base === null || Array.isArray(base)) return over as T;
  const out: any = { ...base };
  for (const k of Object.keys(over)) out[k] = merge((base as any)[k], over[k]);
  return out;
}

export function configExists(): boolean {
  return fs.existsSync(configPath());
}

export function loadConfig(): Config {
  if (!configExists()) {
    throw new Error(`Config não encontrada em ${configPath()}. Rode: gpu-worker init`);
  }
  const raw = JSON.parse(fs.readFileSync(configPath(), "utf8"));
  const cfg = merge(DEFAULTS as any, raw) as Config;
  cfg.tokens = raw.tokens ?? [];
  cfg.signing_secret = raw.signing_secret;
  if (!cfg.signing_secret) throw new Error("signing_secret ausente na config. Rode: gpu-worker init --force");
  return cfg;
}

export function saveConfig(cfg: Config): void {
  atomicWriteFile(configPath(), JSON.stringify(cfg, null, 2) + "\n", 0o600);
}
