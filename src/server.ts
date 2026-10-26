import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { App } from "./app.js";
import { hashToken } from "./config.js";
import { WorkerError } from "./errors.js";
import { buildMcpServer } from "./mcp.js";
import { verify } from "./signing.js";
import { log } from "./util.js";
import { VERSION } from "./version.js";

function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(data), ...headers });
  res.end(data);
}

const errBody = (code: string, message: string) => ({ error: { code, message } });

async function readJson(req: http.IncomingMessage, limit = 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw Object.assign(new Error("payload grande demais"), { status: 413 });
    chunks.push(c as Buffer);
  }
  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("JSON inválido"), { status: 400 });
  }
}

export function createHttpServer(app: App): http.Server {
  const windows = new Map<string, { start: number; count: number }>();

  function authenticate(req: http.IncomingMessage): string | null {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
    if (!m) return null;
    const given = Buffer.from(hashToken(m[1].trim()), "hex");
    const match = (maxAgeMs?: number) => {
      let found: string | null = null;
      for (const t of app.tokens(maxAgeMs)) {
        const h = Buffer.from(t.hash, "hex");
        if (h.length === given.length && crypto.timingSafeEqual(h, given)) found = t.name;
      }
      return found;
    };
    // Se não achou, relê a config (no máx. 1x/s) para que um token recém-criado valha na hora.
    return match() ?? match(1000);
  }

  function rateLimited(name: string): boolean {
    const now = Date.now();
    const w = windows.get(name);
    if (!w || now - w.start > 60_000) {
      windows.set(name, { start: now, count: 1 });
      return false;
    }
    w.count++;
    return w.count > app.cfg.limits.rate_limit_per_min;
  }

  async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse) {
    const who = authenticate(req);
    if (!who) {
      return json(res, 401, errBody("UNAUTHORIZED", "Token ausente ou inválido."), { "www-authenticate": "Bearer" });
    }
    if (rateLimited(who)) {
      return json(res, 429, errBody("RATE_LIMITED", "Muitas requisições."), { "retry-after": "30" });
    }
    if (req.method !== "POST") {
      return json(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Use POST." }, id: null }, { allow: "POST" });
    }
    const body = await readJson(req);
    const server = buildMcpServer(app);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  async function handleUpload(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const p = url.pathname;
    if (!verify(app.cfg.signing_secret, "PUT", p, url.searchParams.get("exp"), url.searchParams.get("sig"))) {
      return json(res, 403, errBody("UNAUTHORIZED", "URL de upload inválida ou expirada."));
    }
    const id = decodeURIComponent(p.slice("/upload/".length));
    let meta;
    try {
      meta = app.inputs.get(id);
    } catch {
      return json(res, 404, errBody("INPUT_NOT_FOUND", "Input não encontrado ou expirado."));
    }
    if (meta.state !== "pending") return json(res, 409, errBody("INPUT_REJECTED", "Este input já recebeu o arquivo."));
    const declared = meta.declared_size ?? 0;
    const len = Number(req.headers["content-length"]);
    if (!Number.isFinite(len) || len <= 0) return json(res, 411, errBody("INPUT_REJECTED", "Content-Length obrigatório."));
    if (len !== declared) {
      return json(res, 400, errBody("INPUT_REJECTED", `O tamanho enviado (${len}) difere do declarado (${declared}).`));
    }
    const blob = app.inputs.blobPath(id);
    let bytes = 0;
    const counter = new Transform({
      transform(chunk, _e, cb) {
        bytes += chunk.length;
        if (bytes > declared) return cb(new Error("excedeu o tamanho declarado"));
        cb(null, chunk);
      },
    });
    try {
      await pipeline(req, counter, fs.createWriteStream(blob, { mode: 0o600 }));
    } catch {
      app.inputs.delete(id);
      return json(res, 400, errBody("INPUT_REJECTED", "Upload interrompido ou maior que o declarado."));
    }
    if (bytes !== declared) {
      app.inputs.delete(id);
      return json(res, 400, errBody("INPUT_REJECTED", "Upload incompleto."));
    }
    try {
      const ready = await app.inputs.finalizeUpload(id);
      return json(res, 201, app.inputView(ready));
    } catch (e) {
      if (e instanceof WorkerError) return json(res, 415, errBody(e.code, e.message));
      throw e;
    }
  }

  async function handleDownload(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const p = url.pathname;
    if (!verify(app.cfg.signing_secret, "GET", p, url.searchParams.get("exp"), url.searchParams.get("sig"))) {
      return json(res, 403, errBody("UNAUTHORIZED", "URL de download inválida ou expirada."));
    }
    const parts = p.split("/"); // ["", "download", jobId, name]
    if (parts.length !== 4) return json(res, 404, errBody("INPUT_NOT_FOUND", "Arquivo não encontrado."));
    let file: string | null = null;
    let mime = "application/octet-stream";
    let name = "";
    try {
      const job = app.jobs.get(parts[2]);
      name = decodeURIComponent(parts[3]);
      file = app.jobs.outputPath(job, name);
      mime = job.files.find((f) => f.name === name)?.mime ?? mime;
    } catch {
      file = null;
    }
    if (!file) return json(res, 404, errBody("INPUT_NOT_FOUND", "Arquivo não encontrado ou expirado."));
    const size = fs.statSync(file).size;
    res.writeHead(200, {
      "content-type": mime,
      "content-length": size,
      "content-disposition": `attachment; filename="${name.replace(/"/g, "")}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    if (req.method === "HEAD") return res.end();
    await pipeline(fs.createReadStream(file), res);
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const p = url.pathname;
      if (req.method === "GET" && p === "/healthz") return json(res, 200, { ok: true, name: "gpu-worker", version: VERSION });
      if (p === "/mcp") return await handleMcp(req, res);
      if (p.startsWith("/upload/") && req.method === "PUT") return await handleUpload(req, res, url);
      if (p.startsWith("/download/") && (req.method === "GET" || req.method === "HEAD")) {
        return await handleDownload(req, res, url);
      }
      return json(res, 404, errBody("JOB_UNAVAILABLE", "Rota não encontrada."));
    } catch (e: any) {
      if (e?.status) return json(res, e.status, errBody("INVALID_PARAMS", e.message));
      log(`erro HTTP: ${e?.stack ?? e}`);
      if (!res.headersSent) json(res, 500, errBody("RUNNER_ERROR", "Erro interno do daemon."));
      else res.destroy();
    }
  });
}
