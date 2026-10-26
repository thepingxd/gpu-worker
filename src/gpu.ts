import { execFile } from "node:child_process";

export interface GpuInfo {
  name: string;
  vram_total_mb: number;
  vram_free_mb: number;
  /** Versão do driver NVIDIA, quando o nvidia-smi está disponível. */
  driver: string | null;
  gpu_count: number;
  /** Backend do PyTorch/ComfyUI (cuda, mps, xpu...) ou "nvidia-smi" quando só ele respondeu. */
  backend: string;
  /** Quem informou: o ComfyUI (o que de fato vai rodar os jobs) ou o nvidia-smi. */
  source: "comfyui" | "nvidia-smi";
}

export interface GpuReport {
  gpu: GpuInfo | null;
  warnings: string[];
}

let comfyUrl: string | null = null;
let cache: { at: number; value: GpuReport } | null = null;

/** Informa onde está o ComfyUI, para usá-lo como fonte primária de detecção. */
export function configureGpu(opts: { comfyuiUrl: string | null }): void {
  comfyUrl = opts.comfyuiUrl ? opts.comfyuiUrl.replace(/\/+$/, "") : null;
  cache = null;
}

const MB = 1024 * 1024;

/** "cuda:0 NVIDIA GeForce RTX 3060 : cudaMallocAsync" -> "NVIDIA GeForce RTX 3060" */
export function cleanDeviceName(raw: string): string {
  const cleaned = raw
    .replace(/^CUDA\s+/i, "")
    .replace(/^[a-z]+:\d+:?\s*/i, "")
    .replace(/\s+:\s+\w+$/, "")
    .trim();
  return cleaned || raw;
}

function detectNvidia(): Promise<GpuInfo | null> {
  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      ["--query-gpu=name,memory.total,memory.free,driver_version", "--format=csv,noheader,nounits"],
      { timeout: 5000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        const rows = stdout
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => l.split(",").map((p) => p.trim()));
        const first = rows[0];
        if (!first || first.length < 4) return resolve(null);
        resolve({
          name: first[0],
          vram_total_mb: parseInt(first[1], 10),
          vram_free_mb: parseInt(first[2], 10),
          driver: first[3],
          gpu_count: rows.length,
          backend: "nvidia-smi",
          source: "nvidia-smi",
        });
      },
    );
  });
}

type ComfyDevice = { kind: "gpu"; info: GpuInfo } | { kind: "cpu" } | null;

async function detectComfy(): Promise<ComfyDevice> {
  if (!comfyUrl) return null;
  try {
    const r = await fetch(`${comfyUrl}/system_stats`, { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return null;
    const j: any = await r.json();
    const devices: any[] = Array.isArray(j?.devices) ? j.devices : [];
    const d = devices[0];
    if (!d) return null;
    const type = String(d.type ?? "").toLowerCase();
    if (type === "cpu") return { kind: "cpu" };
    return {
      kind: "gpu",
      info: {
        name: cleanDeviceName(String(d.name ?? type)),
        vram_total_mb: Math.round(Number(d.vram_total ?? 0) / MB),
        vram_free_mb: Math.round(Number(d.vram_free ?? 0) / MB),
        driver: null,
        gpu_count: devices.length,
        backend: type || "desconhecido",
        source: "comfyui",
      },
    };
  } catch {
    return null;
  }
}

/**
 * Detecta a GPU que vai rodar os jobs. O ComfyUI é a fonte primária, porque é ele quem de fato usa
 * o dispositivo (NVIDIA, AMD, Intel, Apple). O nvidia-smi entra como complemento (versão do driver)
 * e como fallback quando o ComfyUI não está no ar.
 */
export async function detectGpuReport(maxAgeMs = 1500): Promise<GpuReport> {
  if (cache && Date.now() - cache.at < maxAgeMs) return cache.value;
  const [nv, cf] = await Promise.all([detectNvidia(), detectComfy()]);
  const warnings: string[] = [];
  let gpu: GpuInfo | null = null;

  if (cf?.kind === "gpu") {
    gpu = { ...cf.info, driver: nv?.driver ?? null };
  } else if (cf?.kind === "cpu") {
    warnings.push(
      nv
        ? `O ComfyUI está rodando em CPU, mas o nvidia-smi vê a GPU "${nv.name}". Em notebook com placa dedicada, inicie o ComfyUI na GPU dedicada (sem --cpu, com PyTorch com CUDA).`
        : "O ComfyUI está rodando em CPU (nenhuma GPU em uso). Jobs vão funcionar, mas muito devagar; aumente limits.default_timeout_s.",
    );
  } else {
    gpu = nv;
    if (!nv) warnings.push("Nenhuma GPU detectada (nem pelo ComfyUI, nem pelo nvidia-smi).");
    else if (comfyUrl) warnings.push("ComfyUI inacessível; mostrando a GPU pelo nvidia-smi. Suba o ComfyUI para confirmar qual dispositivo ele usa.");
  }

  const value = { gpu, warnings };
  cache = { at: Date.now(), value };
  return value;
}

/** Atalho para quem só precisa da GPU. */
export async function detectGpu(maxAgeMs = 1500): Promise<GpuInfo | null> {
  return (await detectGpuReport(maxAgeMs)).gpu;
}
