import crypto from "node:crypto";
import dns from "node:dns";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { WorkerError } from "./errors.js";

const V4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT (inclui a tailnet)
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function v4ToInt(ip: string): number {
  const p = ip.split(".").map(Number);
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

function v4Blocked(ip: string): boolean {
  const n = v4ToInt(ip);
  for (const [base, bits] of V4_BLOCKED) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if (((n & mask) >>> 0) === ((v4ToInt(base) & mask) >>> 0)) return true;
  }
  return false;
}

function expandV6(ip: string): number[] | null {
  let s = ip.toLowerCase().split("%")[0];
  // IPv4 embutido no final (ex: ::ffff:1.2.3.4)
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (net.isIPv4(tail) === false) return null;
    const n = v4ToInt(tail);
    s = s.slice(0, lastColon + 1) + ((n >>> 16) & 0xffff).toString(16) + ":" + (n & 0xffff).toString(16);
  }
  const parts = s.split("::");
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(":") : [];
  const rest = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (parts.length === 1 ? head.length !== 8 : missing < 0) return null;
  const all = parts.length === 1 ? head : [...head, ...Array(missing).fill("0"), ...rest];
  const nums = all.map((h) => parseInt(h, 16));
  return nums.some((x) => Number.isNaN(x)) ? null : nums;
}

export function isBlockedIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return v4Blocked(ip);
  if (family === 6) {
    const h = expandV6(ip);
    if (!h) return true;
    if (h.every((x) => x === 0)) return true; // ::
    if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return true; // ::1
    // IPv4-mapped (::ffff:a.b.c.d)
    if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) {
      return v4Blocked(`${h[6] >> 8}.${h[6] & 255}.${h[7] >> 8}.${h[7] & 255}`);
    }
    if ((h[0] & 0xffc0) === 0xfe80) return true; // link-local
    if ((h[0] & 0xfe00) === 0xfc00) return true; // ULA
    if ((h[0] >> 8) === 0xff) return true; // multicast
    if (h[0] === 0x64 && h[1] === 0xff9b) return true; // NAT64
    if (h[0] === 0x2001 && h[1] === 0x0db8) return true; // documentação
    return false;
  }
  return true;
}

export interface DownloadOptions {
  maxBytes: number;
  allowlist: string[];
  maxRedirects: number;
  allowPrivate: boolean;
  totalTimeoutMs: number;
}

function checkUrl(u: URL, o: DownloadOptions): void {
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new WorkerError("INPUT_REJECTED", "Só http(s) é aceito em fetch_input.");
  }
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (o.allowlist.length > 0) {
    const ok = o.allowlist.some((a) => {
      const d = a.toLowerCase();
      return host === d || host.endsWith("." + d);
    });
    if (!ok) throw new WorkerError("INPUT_REJECTED", `Domínio não permitido: ${host}`);
  }
  if (net.isIP(host) && !o.allowPrivate && isBlockedIp(host)) {
    throw new WorkerError("INPUT_REJECTED", "Endereço de destino bloqueado.");
  }
}

function guardedLookup(allowPrivate: boolean) {
  return (hostname: string, options: any, cb: any) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
      if (err) return cb(err);
      if (!allowPrivate && addrs.some((a) => isBlockedIp(a.address))) {
        return cb(new Error("Endereço de destino bloqueado."));
      }
      if (options && options.all) return cb(null, addrs);
      return cb(null, addrs[0].address, addrs[0].family);
    });
  };
}

function requestOnce(u: URL, o: DownloadOptions): Promise<http.IncomingMessage> {
  const lib = u.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      u,
      {
        method: "GET",
        headers: { "user-agent": "gpu-worker" },
        timeout: 30_000,
        lookup: guardedLookup(o.allowPrivate) as any,
      },
      resolve,
    );
    req.on("timeout", () => req.destroy(new Error("timeout de conexão")));
    req.on("error", reject);
    req.end();
  });
}

/** Baixa uma URL para um arquivo, com proteções anti-SSRF, limite de tamanho e de redirects. */
export async function safeDownload(
  urlStr: string,
  destPath: string,
  o: DownloadOptions,
): Promise<{ bytes: number; sha256: string }> {
  let current: URL;
  try {
    current = new URL(urlStr);
  } catch {
    throw new WorkerError("INVALID_PARAMS", "URL inválida.");
  }
  for (let hop = 0; ; hop++) {
    checkUrl(current, o);
    let res: http.IncomingMessage;
    try {
      res = await requestOnce(current, o);
    } catch (e: any) {
      throw new WorkerError("INPUT_REJECTED", `Falha ao baixar: ${e?.message ?? e}`);
    }
    const code = res.statusCode ?? 0;
    if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
      res.resume();
      if (hop >= o.maxRedirects) throw new WorkerError("INPUT_REJECTED", "Redirects demais.");
      current = new URL(res.headers.location, current);
      continue;
    }
    if (code !== 200) {
      res.resume();
      throw new WorkerError("INPUT_REJECTED", `Servidor respondeu HTTP ${code}.`);
    }
    const declared = Number(res.headers["content-length"] ?? 0);
    if (declared > o.maxBytes) {
      res.resume();
      throw new WorkerError("INPUT_REJECTED", "Arquivo maior que o limite permitido.");
    }
    const hash = crypto.createHash("sha256");
    let bytes = 0;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        bytes += chunk.length;
        if (bytes > o.maxBytes) return cb(new WorkerError("INPUT_REJECTED", "Arquivo maior que o limite permitido."));
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    const timer = setTimeout(() => res.destroy(new Error("timeout do download")), o.totalTimeoutMs);
    try {
      await pipeline(res, counter, fs.createWriteStream(destPath, { mode: 0o600 }));
    } catch (e: any) {
      fs.rmSync(destPath, { force: true });
      if (e instanceof WorkerError) throw e;
      throw new WorkerError("INPUT_REJECTED", `Falha ao baixar: ${e?.message ?? e}`);
    } finally {
      clearTimeout(timer);
    }
    return { bytes, sha256: hash.digest("hex") };
  }
}
