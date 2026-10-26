import { execFile } from "node:child_process";

export interface GpuInfo {
  name: string;
  vram_total_mb: number;
  vram_free_mb: number;
  driver: string;
  gpu_count: number;
}

let cache: { at: number; value: GpuInfo | null } | null = null;

/** Detecta a GPU NVIDIA via nvidia-smi. Retorna null se não houver. */
export function detectGpu(maxAgeMs = 1500): Promise<GpuInfo | null> {
  if (cache && Date.now() - cache.at < maxAgeMs) return Promise.resolve(cache.value);
  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      ["--query-gpu=name,memory.total,memory.free,driver_version", "--format=csv,noheader,nounits"],
      { timeout: 5000, windowsHide: true },
      (err, stdout) => {
        let value: GpuInfo | null = null;
        if (!err) {
          const rows = stdout
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean)
            .map((l) => l.split(",").map((p) => p.trim()));
          const first = rows[0];
          if (first && first.length >= 4) {
            value = {
              name: first[0],
              vram_total_mb: parseInt(first[1], 10),
              vram_free_mb: parseInt(first[2], 10),
              driver: first[3],
              gpu_count: rows.length,
            };
          }
        }
        cache = { at: Date.now(), value };
        resolve(value);
      },
    );
  });
}
