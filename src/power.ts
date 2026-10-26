import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { log } from "./util.js";

export interface PowerState {
  /** Há bateria nesta máquina? (desktops devolvem false) */
  has_battery: boolean;
  /** true = rodando na bateria; false = na tomada; null = não deu para saber. */
  on_battery: boolean | null;
  /** Carga em %, ou null. */
  percent: number | null;
}

const NO_BATTERY: PowerState = { has_battery: false, on_battery: false, percent: null };
const UNKNOWN: PowerState = { has_battery: false, on_battery: null, percent: null };

function run(bin: string, args: string[], timeout = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, windowsHide: true }, (err, stdout) => resolve(err ? null : stdout));
  });
}

// ---------- parsers (puros, testáveis) ----------

/** Linux: recebe o conteúdo de /sys/class/power_supply já lido. */
export function parseLinuxSupplies(
  supplies: { type: string; status?: string; capacity?: string; online?: string }[],
): PowerState {
  const batteries = supplies.filter((s) => s.type.toLowerCase() === "battery");
  if (batteries.length === 0) return NO_BATTERY;
  const mains = supplies.filter((s) => ["mains", "usb"].includes(s.type.toLowerCase()));
  const acOnline = mains.some((m) => m.online?.trim() === "1");
  const discharging = batteries.some((b) => b.status?.trim().toLowerCase() === "discharging");
  const caps = batteries.map((b) => parseInt(b.capacity ?? "", 10)).filter((n) => Number.isFinite(n));
  const percent = caps.length ? Math.round(caps.reduce((a, b) => a + b, 0) / caps.length) : null;
  // Na tomada (mains online) manda mais que o status da bateria, que pode dizer "Unknown".
  const on_battery = acOnline ? false : discharging ? true : mains.length > 0 ? false : null;
  return { has_battery: true, on_battery, percent };
}

/** macOS: saída de `pmset -g batt`. */
export function parseMacPmset(out: string): PowerState {
  const src = /Now drawing from '([^']+)'/.exec(out)?.[1];
  const pct = /(\d{1,3})%/.exec(out)?.[1];
  const hasBattery = /InternalBattery/i.test(out);
  if (!hasBattery) return NO_BATTERY;
  return {
    has_battery: true,
    on_battery: src ? /battery/i.test(src) : null,
    percent: pct ? parseInt(pct, 10) : null,
  };
}

/** Windows: JSON de `Get-CimInstance Win32_Battery | Select BatteryStatus,EstimatedChargeRemaining`. */
export function parseWindowsBattery(out: string): PowerState {
  const t = out.trim();
  if (!t) return NO_BATTERY; // sem objeto Win32_Battery = desktop
  try {
    const j = JSON.parse(t);
    const b = Array.isArray(j) ? j[0] : j;
    if (!b) return NO_BATTERY;
    const status = Number(b.BatteryStatus);
    // 1 = descarregando; 2 = na tomada; 3..9 = carregando/cheia/etc. (todos na tomada)
    const on_battery = Number.isFinite(status) ? status === 1 || status === 4 || status === 5 : null;
    const percent = Number.isFinite(Number(b.EstimatedChargeRemaining)) ? Number(b.EstimatedChargeRemaining) : null;
    return { has_battery: true, on_battery, percent };
  } catch {
    return UNKNOWN;
  }
}

// ---------- leitura ----------

let cache: { at: number; value: PowerState } | null = null;

/** Só para testes: GPU_WORKER_FAKE_POWER="battery:15" | "ac:80" | "none". */
function fakePower(): PowerState | null {
  const v = process.env.GPU_WORKER_FAKE_POWER;
  if (!v) return null;
  if (v === "none") return NO_BATTERY;
  const m = /^(battery|ac):(\d{1,3})$/.exec(v);
  if (!m) return null;
  return { has_battery: true, on_battery: m[1] === "battery", percent: parseInt(m[2], 10) };
}

export async function getPowerState(maxAgeMs = 10_000): Promise<PowerState> {
  const fake = fakePower();
  if (fake) return fake;
  if (cache && Date.now() - cache.at < maxAgeMs) return cache.value;
  let value: PowerState = UNKNOWN;
  try {
    if (process.platform === "linux") {
      const dir = "/sys/class/power_supply";
      if (!fs.existsSync(dir)) value = NO_BATTERY;
      else {
        const read = (d: string, f: string) => {
          try {
            return fs.readFileSync(path.join(dir, d, f), "utf8");
          } catch {
            return undefined;
          }
        };
        const supplies = fs.readdirSync(dir).map((d) => ({
          type: read(d, "type")?.trim() ?? "",
          status: read(d, "status"),
          capacity: read(d, "capacity"),
          online: read(d, "online"),
        }));
        value = parseLinuxSupplies(supplies);
      }
    } else if (process.platform === "darwin") {
      const out = await run("pmset", ["-g", "batt"]);
      value = out ? parseMacPmset(out) : UNKNOWN;
    } else if (process.platform === "win32") {
      const out = await run("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Battery | Select-Object -First 1 BatteryStatus,EstimatedChargeRemaining | ConvertTo-Json -Compress",
      ]);
      value = out === null ? UNKNOWN : parseWindowsBattery(out);
    }
  } catch {
    value = UNKNOWN;
  }
  cache = { at: Date.now(), value };
  return value;
}

// ---------- manter acordado ----------

/**
 * Impede a suspensão por inatividade enquanto há job rodando (com contagem de referências).
 * Best-effort: se a ferramenta do sistema não existir, só registra um aviso uma vez.
 * Não impede a suspensão por fechar a tampa; isso depende da configuração do sistema operacional.
 */
export class KeepAwake {
  private refs = 0;
  private child: ChildProcess | null = null;
  private warned = false;

  constructor(private enabled: boolean) {}

  acquire(): void {
    if (!this.enabled) return;
    this.refs++;
    if (this.refs === 1) this.start();
  }

  release(): void {
    if (!this.enabled || this.refs === 0) return;
    this.refs--;
    if (this.refs === 0) this.stop();
  }

  active(): boolean {
    return this.child !== null && !this.child.killed;
  }

  private warnOnce(msg: string) {
    if (this.warned) return;
    this.warned = true;
    log(`AVISO: ${msg}`);
  }

  private start() {
    let cmd: string;
    let args: string[];
    if (process.platform === "linux") {
      cmd = "systemd-inhibit";
      args = ["--what=sleep:idle", "--who=gpu-worker", "--why=Job de GPU em execução", "--mode=block", "sleep", "infinity"];
    } else if (process.platform === "darwin") {
      cmd = "caffeinate";
      args = ["-i", "-s", "-w", String(process.pid)];
    } else if (process.platform === "win32") {
      // ES_CONTINUOUS | ES_SYSTEM_REQUIRED: vale enquanto este processo PowerShell viver.
      cmd = "powershell.exe";
      args = [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Add-Type -Namespace GW -Name Power -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);'; [GW.Power]::SetThreadExecutionState(0x80000001) | Out-Null; Start-Sleep -Seconds 86400",
      ];
    } else {
      this.warnOnce(`keep-awake não suportado em ${process.platform}`);
      return;
    }
    try {
      const c = spawn(cmd, args, { stdio: "ignore", windowsHide: true });
      c.on("error", () => {
        this.warnOnce(`não consegui executar "${cmd}"; a máquina pode suspender durante um job`);
        if (this.child === c) this.child = null;
      });
      c.on("exit", (code) => {
        if (this.child === c) this.child = null;
        // Saiu sozinho enquanto ainda havia job: o inibidor não funcionou (sem sessão systemd/D-Bus, sem permissão...).
        if (this.refs > 0 && code !== 0 && code !== null) {
          this.warnOnce(`"${cmd}" terminou com código ${code}; não consegui impedir a suspensão durante o job`);
        }
      });
      this.child = c;
    } catch {
      this.warnOnce(`não consegui executar "${cmd}"; a máquina pode suspender durante um job`);
    }
  }

  private stop() {
    if (this.child) {
      try {
        this.child.kill();
      } catch {
        /* ignora */
      }
      this.child = null;
    }
  }
}
