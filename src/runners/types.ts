import type { z } from "zod";
import type { InputStore } from "../inputs.js";

export interface RunContext {
  jobId: string;
  params: any;
  outDir: string;
  signal: AbortSignal;
  inputs: InputStore;
  progress(value: number): void;
  log(message: string): void;
}

export interface RunResult {
  files: { name: string; mime: string }[];
  metadata: { model?: string; seed?: number };
}

export interface RunnerProbe {
  available: boolean;
  reason?: string;
  details?: Record<string, unknown>;
}

export interface Runner {
  type: string;
  description: string;
  paramsSchema: z.ZodType;
  /** VRAM total mínima da GPU para aceitar o job. */
  minVramMb: number;
  probe(): Promise<RunnerProbe>;
  /** Validações que dependem do estado da máquina (modelos instalados, inputs). Lança WorkerError. */
  precheck(params: any, inputs: InputStore): Promise<void>;
  run(ctx: RunContext): Promise<RunResult>;
}
