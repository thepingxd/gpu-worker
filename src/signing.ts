import crypto from "node:crypto";

/** Assina (método, caminho, expiração em epoch segundos) com HMAC-SHA256. */
export function sign(secret: string, method: string, urlPath: string, exp: number): string {
  return crypto.createHmac("sha256", secret).update(`${method}\n${urlPath}\n${exp}`).digest("hex");
}

export function verify(
  secret: string,
  method: string,
  urlPath: string,
  expStr: string | null,
  sig: string | null,
): boolean {
  if (!expStr || !sig) return false;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
  const expected = Buffer.from(sign(secret, method, urlPath, exp), "hex");
  let given: Buffer;
  try {
    given = Buffer.from(sig, "hex");
  } catch {
    return false;
  }
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}
