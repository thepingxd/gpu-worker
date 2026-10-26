import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import { WorkerError } from "./errors.js";
import { safeDownload } from "./netguard.js";
import { hashFile, nowIso, randomId, rmrf, sanitizeFileName } from "./util.js";

export interface InputMeta {
  id: string;
  name: string;
  mime: string | null;
  size: number;
  sha256: string | null;
  state: "pending" | "ready";
  source: "fetch" | "upload";
  pinned: boolean;
  created_at: string;
  expires_at: string | null;
  declared_size?: number;
}

/** Detecta o tipo pelo conteúdo (magic bytes). Retorna null se não for um tipo aceito. */
export function detectMime(head: Buffer): string | null {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.length >= 12 && head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  if (head.length >= 6 && /^GIF8[79]a$/.test(head.toString("ascii", 0, 6))) return "image/gif";
  // .blend sem compressão começa com "BLENDER"; compactado (Blender 3+) usa zstd.
  if (head.length >= 7 && head.toString("ascii", 0, 7) === "BLENDER") return "application/x-blender";
  if (head.length >= 4 && head[0] === 0x28 && head[1] === 0xb5 && head[2] === 0x2f && head[3] === 0xfd) {
    return "application/x-blender";
  }
  return null;
}

export const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/x-blender": "blend",
};

export class InputStore {
  private dir: string;
  constructor(
    private cfg: Config,
    dataDir: string,
  ) {
    this.dir = path.join(dataDir, "inputs");
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private metaPath(id: string) {
    return path.join(this.dir, id, "meta.json");
  }
  blobPath(id: string) {
    return path.join(this.dir, id, "blob");
  }

  private writeMeta(m: InputMeta) {
    fs.mkdirSync(path.join(this.dir, m.id), { recursive: true });
    fs.writeFileSync(this.metaPath(m.id), JSON.stringify(m, null, 2));
  }

  private expiry(): string {
    return new Date(Date.now() + this.cfg.limits.ttl_hours * 3600_000).toISOString();
  }

  private validId(id: string) {
    return /^inp_[0-9a-f]{16}$/.test(id);
  }

  get(id: string): InputMeta {
    if (!this.validId(id) || !fs.existsSync(this.metaPath(id))) {
      throw new WorkerError("INPUT_NOT_FOUND", `Input não encontrado: ${id}`);
    }
    const m = JSON.parse(fs.readFileSync(this.metaPath(id), "utf8")) as InputMeta;
    if (m.expires_at && new Date(m.expires_at).getTime() < Date.now()) {
      this.delete(id);
      throw new WorkerError("INPUT_NOT_FOUND", `Input expirado: ${id}`);
    }
    return m;
  }

  getReady(id: string): InputMeta {
    const m = this.get(id);
    if (m.state !== "ready") throw new WorkerError("INPUT_NOT_FOUND", `Input ainda sem upload concluído: ${id}`);
    return m;
  }

  list(): InputMeta[] {
    if (!fs.existsSync(this.dir)) return [];
    const out: InputMeta[] = [];
    for (const id of fs.readdirSync(this.dir)) {
      try {
        out.push(this.get(id));
      } catch {
        /* ignora expirados/corrompidos */
      }
    }
    return out.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  private usedBytes(): number {
    return this.list().reduce((n, m) => n + (m.state === "ready" ? m.size : (m.declared_size ?? 0)), 0);
  }

  private checkQuota(size: number) {
    const maxFile = this.cfg.limits.max_input_mb * 1024 * 1024;
    if (size > maxFile) {
      throw new WorkerError("INPUT_REJECTED", `Arquivo excede o limite de ${this.cfg.limits.max_input_mb} MB.`);
    }
    const quota = this.cfg.limits.inputs_quota_mb * 1024 * 1024;
    if (this.usedBytes() + size > quota) {
      throw new WorkerError("INPUT_REJECTED", "Cota da pasta de inputs esgotada. Apague inputs antigos.");
    }
  }

  createPending(name: string, size: number): InputMeta {
    this.checkQuota(size);
    const m: InputMeta = {
      id: randomId("inp", 8),
      name: sanitizeFileName(name),
      mime: null,
      size: 0,
      sha256: null,
      state: "pending",
      source: "upload",
      pinned: false,
      created_at: nowIso(),
      expires_at: new Date(Date.now() + this.cfg.limits.upload_url_ttl_s * 1000 * 2).toISOString(),
      declared_size: size,
    };
    this.writeMeta(m);
    return m;
  }

  /** Chamado depois que o PUT gravou o blob. Valida pelo conteúdo e marca como pronto. */
  async finalizeUpload(id: string): Promise<InputMeta> {
    const m = this.get(id);
    const blob = this.blobPath(id);
    const stat = fs.statSync(blob);
    return this.finalizeBlob(m, blob, stat.size, "upload");
  }

  private async finalizeBlob(m: InputMeta, blob: string, size: number, source: "fetch" | "upload"): Promise<InputMeta> {
    const fd = fs.openSync(blob, "r");
    const head = Buffer.alloc(32);
    const n = fs.readSync(fd, head, 0, 32, 0);
    fs.closeSync(fd);
    const mime = detectMime(head.subarray(0, n));
    if (!mime) {
      this.delete(m.id);
      throw new WorkerError("INPUT_REJECTED", "Tipo de arquivo não aceito (validado pelo conteúdo).");
    }
    const sha256 = await hashFile(blob);
    const ready: InputMeta = {
      ...m,
      mime,
      size,
      sha256,
      state: "ready",
      source,
      expires_at: m.pinned ? null : this.expiry(),
    };
    delete ready.declared_size;
    this.writeMeta(ready);
    return ready;
  }

  async addFromUrl(url: string, expectedSha256?: string): Promise<InputMeta> {
    const id = randomId("inp", 8);
    fs.mkdirSync(path.join(this.dir, id), { recursive: true });
    const blob = this.blobPath(id);
    const maxBytes = this.cfg.limits.max_input_mb * 1024 * 1024;
    try {
      const { bytes, sha256 } = await safeDownload(url, blob, {
        maxBytes,
        allowlist: this.cfg.fetch.allowlist,
        maxRedirects: this.cfg.fetch.max_redirects,
        allowPrivate: this.cfg.fetch.allow_private_addresses,
        totalTimeoutMs: this.cfg.fetch.timeout_s * 1000,
      });
      if (expectedSha256 && expectedSha256.toLowerCase() !== sha256) {
        throw new WorkerError("INPUT_REJECTED", "sha256 não confere com o arquivo baixado.");
      }
      this.checkQuota(bytes);
      let name = "download";
      try {
        name = sanitizeFileName(path.basename(new URL(url).pathname) || "download");
      } catch {
        /* mantém o padrão */
      }
      const meta: InputMeta = {
        id,
        name,
        mime: null,
        size: bytes,
        sha256,
        state: "pending",
        source: "fetch",
        pinned: false,
        created_at: nowIso(),
        expires_at: null,
      };
      return await this.finalizeBlob(meta, blob, bytes, "fetch");
    } catch (e) {
      rmrf(path.join(this.dir, id));
      throw e;
    }
  }

  delete(id: string): boolean {
    if (!this.validId(id)) return false;
    const p = path.join(this.dir, id);
    const existed = fs.existsSync(p);
    rmrf(p);
    return existed;
  }

  pin(id: string): InputMeta {
    const m = this.getReady(id);
    m.pinned = true;
    m.expires_at = null;
    this.writeMeta(m);
    return m;
  }

  cleanup(): number {
    let removed = 0;
    if (!fs.existsSync(this.dir)) return 0;
    for (const id of fs.readdirSync(this.dir)) {
      try {
        const m = JSON.parse(fs.readFileSync(this.metaPath(id), "utf8")) as InputMeta;
        if (m.expires_at && new Date(m.expires_at).getTime() < Date.now()) {
          this.delete(id);
          removed++;
        }
      } catch {
        // pasta sem meta (download interrompido): remove só se for antiga
        try {
          const age = Date.now() - fs.statSync(path.join(this.dir, id)).mtimeMs;
          if (age > 3600_000) {
            this.delete(id);
            removed++;
          }
        } catch {
          /* ignora */
        }
      }
    }
    return removed;
  }
}
