import { execFile } from "node:child_process";

const CANDIDATES = [
  "tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "C:\\Program Files\\Tailscale\\tailscale.exe",
];

function run(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(bin, ["ip", "-4"], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const ip = stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => /^\d+\.\d+\.\d+\.\d+$/.test(l));
      resolve(ip ?? null);
    });
  });
}

/** IPv4 da máquina na tailnet, ou null se o Tailscale não estiver instalado/conectado. */
export async function tailscaleIp(): Promise<string | null> {
  for (const bin of CANDIDATES) {
    const ip = await run(bin);
    if (ip) return ip;
  }
  return null;
}

/** Resolve o endereço de bind. Nunca aceita 0.0.0.0 / ::. */
export async function resolveBind(bind: string): Promise<string> {
  if (bind === "0.0.0.0" || bind === "::" || bind === "") {
    throw new Error("bind em 0.0.0.0/:: não é permitido. Use 'tailscale' ou um IP específico.");
  }
  if (bind !== "tailscale") return bind;
  const ip = await tailscaleIp();
  if (!ip) {
    throw new Error(
      "Tailscale não encontrado ou desconectado. Instale e conecte o Tailscale, " +
        "ou para teste local rode: gpu-worker init --force --bind 127.0.0.1",
    );
  }
  return ip;
}
