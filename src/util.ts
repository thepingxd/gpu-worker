import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function randomId(prefix: string, bytes = 6): string {
  return `${prefix}_${crypto.randomBytes(bytes).toString("hex")}`;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function atomicWriteFile(file: string, data: string, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
}

export function sanitizeFileName(name: string, fallback = "file"): string {
  const base = path.basename(name.replace(/\\/g, "/"));
  const clean = base.replace(/[^\w.\- ]/g, "_").replace(/^\.+/, "").trim().slice(0, 120);
  return clean || fallback;
}

export function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    const s = fs.createReadStream(file);
    s.on("data", (c) => h.update(c));
    s.on("error", reject);
    s.on("end", () => resolve(h.digest("hex")));
  });
}

export function rmrf(p: string): void {
  fs.rmSync(p, { recursive: true, force: true });
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function log(msg: string): void {
  console.log(`${new Date().toISOString()} ${msg}`);
}
