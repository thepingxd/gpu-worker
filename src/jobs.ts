import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import { WorkerError, type ErrorCode } from "./errors.js";
import { detectGpu } from "./gpu.js";
import type { InputStore } from "./inputs.js";
import type { Runner } from "./runners/types.js";
import { atomicWriteFile, hashFile, log, nowIso, randomId, rmrf } from "./util.js";

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface StoredFile {
  name: string;
  mime: string;
  size: number;
  sha256: string;
}

export interface Job {
  id: string;
  type: string;
  params: unknown;
  status: JobStatus;
  progress: number;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  timeout_s: number;
  files: StoredFile[];
  metadata: { duration_s?: number; model?: string; seed?: number; gpu?: string };
  error: { code: ErrorCode; message: string } | null;
  logs: string[];
}

const TERMINAL: JobStatus[] = ["done", "failed", "cancelled"];
const LOG_LINES = 20;

export class JobManager {
  private jobs = new Map<string, Job>();
  private file: string;
  private outRoot: string;
  private busy = false;
  private current: { id: string; abort: AbortController; reason?: "cancel" | "timeout" | "shutdown" } | null = null;
  private persistTimer: NodeJS.Timeout | null = null;

  constructor(
    private cfg: Config,
    private dataDir: string,
    private runners: Runner[],
    private inputs: InputStore,
  ) {
    this.file = path.join(dataDir, "jobs.json");
    this.outRoot = path.join(dataDir, "outputs");
    fs.mkdirSync(this.outRoot, { recursive: true });
    this.load();
  }

  // ---------- persistência ----------
  private load() {
    if (!fs.existsSync(this.file)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, "utf8")) as { jobs: Job[] };
      for (const j of data.jobs) {
        if (j.status === "running") {
          j.status = "failed";
          j.error = { code: "RUNNER_ERROR", message: "O daemon foi reiniciado durante a execução." };
          j.finished_at = nowIso();
        }
        this.jobs.set(j.id, j);
      }
    } catch (e: any) {
      log(`aviso: jobs.json ilegível (${e?.message}); começando com fila vazia`);
    }
  }

  private persistNow() {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    atomicWriteFile(this.file, JSON.stringify({ jobs: [...this.jobs.values()] }));
  }

  private persist() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => this.persistNow(), 200);
  }

  /** Retoma os jobs que estavam na fila quando o daemon parou. */
  resume() {
    const n = this.queueLength();
    if (n > 0) log(`retomando ${n} job(s) que estavam na fila`);
    void this.pump();
  }

  // ---------- API ----------
  runner(type: string): Runner | undefined {
    return this.runners.find((r) => r.type === type);
  }

  queueLength(): number {
    return [...this.jobs.values()].filter((j) => j.status === "queued").length;
  }

  isBusy(): boolean {
    return this.current !== null;
  }

  async submit(type: string, rawParams: unknown, timeoutS?: number): Promise<Job> {
    const runner = this.runner(type);
    if (!runner) {
      throw new WorkerError("JOB_UNAVAILABLE", `Tipo de job desconhecido: ${type}. Use list_capabilities.`);
    }
    const parsed = runner.paramsSchema.safeParse(rawParams);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join(".") || "params"}: ${i.message}`).join("; ");
      throw new WorkerError("INVALID_PARAMS", msg);
    }
    const gpu = await detectGpu();
    if (gpu && gpu.vram_total_mb < runner.minVramMb) {
      throw new WorkerError(
        "INSUFFICIENT_VRAM",
        `Este job exige ao menos ${runner.minVramMb} MB de VRAM; a GPU tem ${gpu.vram_total_mb} MB.`,
      );
    }
    await runner.precheck(parsed.data, this.inputs);
    if (this.queueLength() >= this.cfg.limits.max_queue) {
      throw new WorkerError("QUEUE_FULL", `Fila cheia (${this.cfg.limits.max_queue} jobs).`);
    }
    const timeout = Math.min(timeoutS ?? this.cfg.limits.default_timeout_s, this.cfg.limits.max_timeout_s);
    const job: Job = {
      id: randomId("job", 6),
      type,
      params: parsed.data,
      status: "queued",
      progress: 0,
      created_at: nowIso(),
      timeout_s: timeout,
      files: [],
      metadata: {},
      error: null,
      logs: [],
    };
    this.jobs.set(job.id, job);
    this.persist();
    log(`job ${job.id} (${type}) na fila`);
    void this.pump();
    return job;
  }

  get(id: string): Job {
    const j = this.jobs.get(id);
    if (!j) throw new WorkerError("JOB_UNAVAILABLE", `Job não encontrado: ${id}`);
    return j;
  }

  list(status?: JobStatus, limit = 20): Job[] {
    return [...this.jobs.values()]
      .filter((j) => !status || j.status === status)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit);
  }

  cancel(id: string): Job {
    const j = this.get(id);
    if (TERMINAL.includes(j.status)) return j;
    if (j.status === "queued") {
      j.status = "cancelled";
      j.error = { code: "CANCELLED", message: "Cancelado antes de iniciar." };
      j.finished_at = nowIso();
      this.persist();
      return j;
    }
    if (this.current?.id === id) {
      this.current.reason = "cancel";
      this.current.abort.abort();
    }
    return j;
  }

  outputPath(job: Job, fileName: string): string | null {
    const f = job.files.find((x) => x.name === fileName);
    if (!f) return null;
    const p = path.join(this.outRoot, job.id, f.name);
    return fs.existsSync(p) ? p : null;
  }

  // ---------- execução ----------
  private async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (;;) {
        const next = [...this.jobs.values()]
          .filter((j) => j.status === "queued")
          .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
        if (!next) break;
        await this.execute(next);
      }
    } finally {
      this.busy = false;
    }
  }

  private sanitizeLog(msg: string): string {
    return msg
      .split(this.dataDir)
      .join("<data>")
      .replace(/gw_[A-Za-z0-9_-]{16,}/g, "[redacted]")
      .replace(/([?&])(sig|exp)=[^&\s]+/g, "$1$2=[redacted]")
      .slice(0, 300);
  }

  private async execute(job: Job) {
    const runner = this.runner(job.type)!;
    const abort = new AbortController();
    this.current = { id: job.id, abort };
    job.status = "running";
    job.started_at = nowIso();
    this.persist();
    log(`job ${job.id} iniciou`);
    const outDir = path.join(this.outRoot, job.id);
    fs.mkdirSync(outDir, { recursive: true });
    const timer = setTimeout(() => {
      if (this.current) this.current.reason = "timeout";
      abort.abort();
    }, job.timeout_s * 1000);

    const pushLog = (m: string) => {
      job.logs.push(this.sanitizeLog(m));
      if (job.logs.length > LOG_LINES) job.logs.splice(0, job.logs.length - LOG_LINES);
    };

    try {
      const res = await runner.run({
        jobId: job.id,
        params: job.params,
        outDir,
        signal: abort.signal,
        inputs: this.inputs,
        progress: (v) => {
          job.progress = Math.max(job.progress, Math.min(1, v));
        },
        log: pushLog,
      });
      const files: StoredFile[] = [];
      let total = 0;
      for (const f of res.files) {
        const p = path.join(outDir, f.name);
        const size = fs.statSync(p).size;
        total += size;
        files.push({ name: f.name, mime: f.mime, size, sha256: await hashFile(p) });
      }
      if (total > this.cfg.limits.max_output_mb * 1024 * 1024) {
        rmrf(outDir);
        throw new WorkerError("RUNNER_ERROR", `A saída excede o limite de ${this.cfg.limits.max_output_mb} MB.`);
      }
      job.files = files;
      job.metadata = { ...res.metadata, gpu: (await detectGpu())?.name };
      job.progress = 1;
      job.status = "done";
    } catch (e: any) {
      const reason = this.current?.reason;
      if (reason === "timeout") {
        job.status = "failed";
        job.error = { code: "TIMEOUT", message: `Excedeu o limite de ${job.timeout_s}s.` };
      } else if (reason === "cancel") {
        job.status = "cancelled";
        job.error = { code: "CANCELLED", message: "Cancelado pelo agente." };
      } else if (reason === "shutdown") {
        job.status = "failed";
        job.error = { code: "RUNNER_ERROR", message: "O daemon foi encerrado durante a execução." };
      } else if (e instanceof WorkerError) {
        job.status = e.code === "CANCELLED" ? "cancelled" : "failed";
        job.error = { code: e.code, message: this.sanitizeLog(e.message) };
      } else {
        job.status = "failed";
        job.error = { code: "RUNNER_ERROR", message: this.sanitizeLog(String(e?.message ?? e)) };
      }
      pushLog(`${job.status}: ${job.error?.code}`);
    } finally {
      clearTimeout(timer);
      job.finished_at = nowIso();
      job.metadata.duration_s = Math.round((Date.parse(job.finished_at) - Date.parse(job.started_at!)) / 100) / 10;
      this.current = null;
      this.persist();
      log(`job ${job.id} terminou: ${job.status}${job.error ? " (" + job.error.code + ")" : ""}`);
    }
  }

  // ---------- manutenção ----------
  cleanup(): number {
    const cutoff = Date.now() - this.cfg.limits.ttl_hours * 3600_000;
    let n = 0;
    for (const j of [...this.jobs.values()]) {
      if (TERMINAL.includes(j.status) && j.finished_at && Date.parse(j.finished_at) < cutoff) {
        rmrf(path.join(this.outRoot, j.id));
        this.jobs.delete(j.id);
        n++;
      }
    }
    if (n) this.persist();
    return n;
  }

  /** Para o job em execução (se houver) e grava o estado. */
  async shutdown() {
    if (this.current) {
      this.current.reason = "shutdown";
      this.current.abort.abort();
      // dá um instante para o runner enviar o interrupt
      await new Promise((r) => setTimeout(r, 500));
    }
    this.persistNow();
  }
}
