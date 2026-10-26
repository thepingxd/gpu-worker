import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type ServicePlatform = "linux" | "darwin" | "win32";

export interface PlanOptions {
  platform: ServicePlatform;
  nodePath: string;
  cliPath: string;
  /** Pasta de config/dados (GPU_WORKER_HOME efetivo). */
  home: string;
  /** Home do usuário (onde ficam ~/.config e ~/Library). */
  userHome: string;
  /** Só é usado se GPU_WORKER_HOME for diferente do padrão. */
  customHome: boolean;
  pathEnv?: string;
  uid?: number;
}

export interface ServicePlan {
  platform: ServicePlatform;
  label: string;
  files: { path: string; content: string }[];
  install: string[][];
  uninstall: string[][];
  status: string[][];
  removeOnUninstall: string[];
  notes: string[];
}

const UNIT = "gpu-worker.service";
const LABEL = "dev.gpu-worker";
const TASK = "gpu-worker";

const xmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const sysdEsc = (s: string) => s.replace(/%/g, "%%").replace(/"/g, '\\"');
const psq = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function planService(o: PlanOptions): ServicePlan {
  if (o.platform === "linux") {
    const unitPath = path.posix.join(o.userHome, ".config/systemd/user", UNIT);
    const env: string[] = [];
    if (o.customHome) env.push(`Environment="GPU_WORKER_HOME=${sysdEsc(o.home)}"`);
    if (o.pathEnv) env.push(`Environment="PATH=${sysdEsc(o.pathEnv)}"`);
    const content = [
      "[Unit]",
      "Description=gpu-worker (daemon MCP para usar a GPU local)",
      "After=network-online.target",
      "Wants=network-online.target",
      "",
      "[Service]",
      "Type=simple",
      `ExecStart="${sysdEsc(o.nodePath)}" "${sysdEsc(o.cliPath)}" start`,
      "Restart=on-failure",
      "RestartSec=10",
      ...env,
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n");
    return {
      platform: "linux",
      label: "systemd (usuário)",
      files: [{ path: unitPath, content }],
      install: [["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", "--now", UNIT]],
      uninstall: [["systemctl", "--user", "disable", "--now", UNIT]],
      status: [["systemctl", "--user", "status", UNIT, "--no-pager"]],
      removeOnUninstall: [unitPath],
      notes: [
        "O serviço inicia quando você faz login. Para iniciar no boot, mesmo sem login: sudo loginctl enable-linger $USER",
        `Logs: journalctl --user -u ${UNIT} -f`,
      ],
    };
  }

  if (o.platform === "darwin") {
    const plistPath = path.posix.join(o.userHome, "Library/LaunchAgents", `${LABEL}.plist`);
    const logPath = path.posix.join(o.home, "daemon.log");
    const envEntries: [string, string][] = [];
    if (o.customHome) envEntries.push(["GPU_WORKER_HOME", o.home]);
    envEntries.push(["PATH", o.pathEnv ?? "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"]);
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEsc(o.nodePath)}</string>
    <string>${xmlEsc(o.cliPath)}</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xmlEsc(logPath)}</string>
  <key>StandardErrorPath</key><string>${xmlEsc(logPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries.map(([k, v]) => `    <key>${k}</key><string>${xmlEsc(v)}</string>`).join("\n")}
  </dict>
</dict>
</plist>
`;
    const uid = o.uid ?? 501;
    return {
      platform: "darwin",
      label: "launchd (LaunchAgent)",
      files: [{ path: plistPath, content }],
      install: [["launchctl", "bootout", `gui/${uid}/${LABEL}`], ["launchctl", "bootstrap", `gui/${uid}`, plistPath]],
      uninstall: [["launchctl", "bootout", `gui/${uid}/${LABEL}`]],
      status: [["launchctl", "print", `gui/${uid}/${LABEL}`]],
      removeOnUninstall: [plistPath],
      notes: [`Inicia quando você faz login. Logs em ${logPath} (sem rotação automática).`],
    };
  }

  // Windows: Tarefa Agendada criada via PowerShell para NÃO herdar "parar se for para a bateria",
  // que é o padrão do schtasks e derrubaria o daemon ao desligar o notebook da tomada.
  const w = path.win32;
  const runPs1 = w.join(o.home, "run.ps1");
  const installPs1 = w.join(o.home, "install-task.ps1");
  const logPath = w.join(o.home, "daemon.log");
  const run = [
    "$ErrorActionPreference = 'Continue'",
    ...(o.customHome ? [`$env:GPU_WORKER_HOME = ${psq(o.home)}`] : []),
    `$log = ${psq(logPath)}`,
    "if ((Test-Path $log) -and ((Get-Item $log).Length -gt 5MB)) { Move-Item -Force $log \"$log.1\" }",
    `& ${psq(o.nodePath)} ${psq(o.cliPath)} start *>> $log`,
    "",
  ].join("\r\n");
  const install = [
    "$ErrorActionPreference = 'Stop'",
    `$arg = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + ${psq(runPs1)} + '"'`,
    "$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg",
    "$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME",
    "$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)",
    `Register-ScheduledTask -TaskName ${psq(TASK)} -Action $action -Trigger $trigger -Settings $settings -Description 'gpu-worker: daemon MCP para usar a GPU local' -Force | Out-Null`,
    `Start-ScheduledTask -TaskName ${psq(TASK)}`,
    "Write-Host 'Tarefa gpu-worker criada e iniciada.'",
    "",
  ].join("\r\n");
  const ps = ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass"];
  return {
    platform: "win32",
    label: "Tarefa Agendada do Windows",
    files: [
      { path: runPs1, content: run },
      { path: installPs1, content: install },
    ],
    install: [[...ps, "-File", installPs1]],
    uninstall: [[...ps, "-Command", `Stop-ScheduledTask -TaskName ${TASK} -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName ${TASK} -Confirm:$false`]],
    status: [[...ps, "-Command", `Get-ScheduledTask -TaskName ${TASK} | Format-List TaskName,State; Get-ScheduledTaskInfo -TaskName ${TASK} | Format-List LastRunTime,LastTaskResult`]],
    removeOnUninstall: [runPs1, installPs1],
    notes: [`Inicia quando você faz login. Logs em ${logPath} (rotacionado em 5 MB).`],
  };
}

export function currentPlanOptions(): PlanOptions {
  const platform = process.platform as ServicePlatform;
  const userHome = os.homedir();
  const defaultHome = path.join(userHome, ".gpu-worker");
  const home = process.env.GPU_WORKER_HOME ?? defaultHome;
  return {
    platform,
    nodePath: process.execPath,
    cliPath: fileURLToPath(new URL("./cli.js", import.meta.url)),
    home,
    userHome,
    customHome: path.resolve(home) !== path.resolve(defaultHome),
    pathEnv: process.env.PATH,
    uid: typeof process.getuid === "function" ? process.getuid() : undefined,
  };
}

function exec(cmd: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd[0], cmd.slice(1), { timeout: 60_000, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? ((err as any).code && typeof (err as any).code === "number" ? (err as any).code : 1) : 0;
      resolve({ code, out: (stdout + stderr).trim() });
    });
  });
}

export async function runService(action: "install" | "uninstall" | "status", plan: ServicePlan, dryRun: boolean): Promise<void> {
  const cmds = action === "install" ? plan.install : action === "uninstall" ? plan.uninstall : plan.status;
  console.log(`Serviço: ${plan.label}`);
  if (dryRun) {
    if (action === "install") {
      for (const f of plan.files) console.log(`\n--- ${f.path} ---\n${f.content}`);
    }
    console.log("Comandos:");
    for (const c of cmds) console.log("  " + c.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" "));
    console.log("\n(dry-run: nada foi escrito nem executado)");
    return;
  }
  if (action === "install") {
    for (const f of plan.files) {
      fs.mkdirSync(path.dirname(f.path), { recursive: true });
      fs.writeFileSync(f.path, f.content, { mode: 0o644 });
      console.log(`escrito: ${f.path}`);
    }
  }
  let failed = false;
  for (const c of cmds) {
    const { code, out } = await exec(c);
    const ignorable = plan.platform === "darwin" && c[1] === "bootout"; // não carregado ainda: normal
    console.log(`$ ${c.join(" ")}${code !== 0 && !ignorable ? `  (código ${code})` : ""}`);
    if (out) console.log(out);
    if (code !== 0 && !ignorable && action !== "status") {
      failed = true;
      break;
    }
  }
  if (action === "uninstall") {
    for (const p of plan.removeOnUninstall) {
      if (fs.existsSync(p)) {
        fs.rmSync(p, { force: true });
        console.log(`removido: ${p}`);
      }
    }
  }
  if (failed) throw new Error(`Falha ao executar '${action}' do serviço. Veja a saída acima.`);
  if (action === "install") {
    console.log("\nServiço instalado e iniciado.");
    for (const n of plan.notes) console.log("- " + n);
  }
}
