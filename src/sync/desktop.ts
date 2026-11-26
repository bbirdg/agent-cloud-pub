/**
 * The Claude desktop app keeps its local MCP servers in claude_desktop_config.json, holds that file in memory while
 * it runs and writes it back, so an edit made while it runs is undone. Its servers are therefore only written while
 * the app is closed; on Windows a waiter started by the sync applies them as soon as the app quits.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { cliCommand } from "../project.ts";

/**
 * The config file the app reads: the Store (MSIX) build keeps it in Claude-Data\<package>, the others in the usual
 * place. On Linux, ~/.config/Claude is the Electron default (not verified against a real install).
 */
export function desktopConfigPath(home: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (platform !== "win32") return path.join(home, ".config", "Claude", "claude_desktop_config.json");
  const data = path.join(home, "AppData", "Local", "Claude-Data");
  const packaged = (existsSync(data) ? readdirSync(data) : [])
    .map((n) => path.join(data, n, "claude_desktop_config.json"))
    .filter((f) => existsSync(f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  return packaged ?? path.join(home, "AppData", "Roaming", "Claude", "claude_desktop_config.json");
}

/** The desktop app's main executable (not the Claude Code CLI, which is also claude.exe). */
const DESKTOP_EXE = "\\\\(app|app-[0-9.]+)\\\\Claude\\.exe$";

/** Process ids of the running desktop app ([] when closed or when it can't be checked on this platform). */
export function desktopPids(): number[] {
  try {
    if (process.platform === "win32") {
      const script = `Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | Where-Object { $_.ExecutablePath -match '${DESKTOP_EXE}' } | ForEach-Object ProcessId`;
      return execFileSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8", windowsHide: true }).split(/\s+/).filter(Boolean).map(Number);
    }
    if (process.platform === "darwin") {
      return execFileSync("pgrep", ["-f", "Claude.app/Contents/MacOS/Claude$"], { encoding: "utf8" }).split(/\s+/).filter(Boolean).map(Number);
    }
  } catch {
    // pgrep exits 1 when nothing matches
  }
  return [];
}

/**
 * Windows: starts a hidden waiter, outside the app's process tree so quitting the app doesn't end it, that waits
 * until the app has closed and then applies its servers. Returns false when one is already waiting.
 */
export function startDesktopWaiter(project: string, home: string, adopt: boolean): boolean {
  const pidFile = path.join(home, ".agent-cloud", "desktop-wait.pid");
  const log = path.join(home, ".agent-cloud", "desktop-sync.log");
  // PowerShell ends a single-quoted string at any of these quote marks; doubling one keeps it literal.
  const q = (s: string) => s.replace(/['‘’‚‛]/g, "$&$&");
  const cli = cliCommand.map((p) => `'${q(p)}'`).join(" ");
  const waiter = [
    `$PID | Set-Content -LiteralPath '${q(pidFile)}'`,
    "try {",
    // Wait for every app process to exit, then check again in case it was reopened meanwhile. Exit code 3: the
    // app was reopened before the write, so wait for the next close.
    "  do {",
    `    while ($p = @(Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | Where-Object { $_.ExecutablePath -match '${DESKTOP_EXE}' } | ForEach-Object ProcessId)) { Wait-Process -Id $p -ErrorAction SilentlyContinue; Start-Sleep -Seconds 1 }`,
    `    & ${cli} sync --apply --from-waiter --harness claude-desktop --project '${q(project)}'${adopt ? " --adopt" : ""} *>> '${q(log)}'`,
    "  } while ($LASTEXITCODE -eq 3)",
    `} finally { Remove-Item -LiteralPath '${q(pidFile)}' -ErrorAction SilentlyContinue }`,
  ].join("\n");
  const encoded = Buffer.from(waiter, "utf16le").toString("base64");
  const launch = [
    `$old = Get-Content -LiteralPath '${q(pidFile)}' -ErrorAction SilentlyContinue`,
    "if ($old -and (Get-Process -Id $old -ErrorAction SilentlyContinue)) { 'waiting'; exit }",
    "$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }",
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'powershell -NoProfile -WindowStyle Hidden -EncodedCommand ${encoded}'; CurrentDirectory = '${q(project)}'; ProcessStartupInformation = $startup }`,
    "if ($r.ReturnValue -ne 0) { throw \"Win32_Process.Create returned $($r.ReturnValue)\" }",
    "'started'",
  ].join("\n");
  return execFileSync("powershell", ["-NoProfile", "-Command", launch], { encoding: "utf8", windowsHide: true }).trim() === "started";
}
