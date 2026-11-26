/** `agent-cloud status`: what's set up on this PC and what's missing, each with the command that fixes it. */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { envScript, findProject, PACKAGE_NAME, packageVersion, pcDir, readPcState, readSettings, secretValues } from "./project.ts";
import type { Catalog } from "./sync/mcp.ts";

export async function main(args: string[]): Promise<void> {
  const value = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  const ok = (t: string) => console.log(`ok       ${t}`);
  const warn = (t: string) => console.log(`check    ${t}`);
  console.log(`agent-cloud ${packageVersion}\n`);

  const pc = readPcState();
  const project = findProject(value("--project"));
  if (!project) return warn(`no agent-cloud folder found: run this inside it, or create one with \`npx ${PACKAGE_NAME} init <folder>\``);
  ok(`folder: ${project}`);

  const s = readSettings(project, { allowNoUrl: true });
  if (!s.memory.url || !s.memory.d1.id || !s.memory.kv.id) return warn("the memory server isn't set up yet: `npx agent-cloud setup`");
  ok(`memory server: ${s.memory.url}`);

  if (pc.off) warn(`agent-cloud is off on this PC (${pc.off}): \`npx agent-cloud on\` turns it back on`);

  // ---------- memory ----------
  const health = await fetch(`${s.memory.url}/health`, { signal: AbortSignal.timeout(5000) }).then((r) => r.text()).catch(() => "");
  health === "ok" ? ok("memory server answers") : warn(`${s.memory.url}/health doesn't answer "ok" (offline, or not deployed: \`npx agent-cloud deploy\`)`);
  const secrets = secretValues();
  const token = secrets.AGENT_MEMORY_TOKEN;
  if (!token) warn("this PC has no device token: on a PC that's set up run `npx agent-cloud device add <name>`, then here `npx agent-cloud secret set AGENT_MEMORY_TOKEN`");
  else if (health === "ok") {
    const status = await fetch(`${s.memory.url}/context`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) }).then((r) => r.status).catch(() => 0);
    status === 200 ? ok("this PC's device token works") : warn(`the device token was refused (HTTP ${status}): revoked? Add a new one with \`npx agent-cloud device add <name>\``);
  }

  // ---------- config ----------
  let catalog: Catalog = { servers: {} };
  try {
    catalog = JSON.parse(readFileSync(path.join(project, "config", "mcp", "catalog.json"), "utf8")) as Catalog;
  } catch {
    warn("config/mcp/catalog.json is missing or not valid JSON");
  }
  const needed = [...new Set([...JSON.stringify(catalog.servers).matchAll(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]!))];
  const missing = needed.filter((n) => !secrets[n]);
  missing.length ? warn(`secrets not set on this PC (their servers are left out): ${missing.join(", ")} -> \`npx agent-cloud secret set <NAME>\``) : ok("every secret the MCP servers need is set");
  // Claude Code reads its servers' secrets from its own environment.
  const notInEnv = needed.filter((n) => secrets[n] && !process.env[n]);
  if (notInEnv.length) {
    warn(
      process.platform === "win32"
        ? `Claude Code won't see ${notInEnv.join(", ")} until it is restarted (new windows read the saved user variables)`
        : `Claude Code won't see ${notInEnv.join(", ")}: add \`source ${envScript()}\` to your shell profile (~/.zshrc or ~/.bashrc), then open a new terminal`,
    );
  }

  const head = (() => {
    try {
      return execFileSync("git", ["-C", project, "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return "";
    }
  })();
  if (!pc.appliedCommit) warn("nothing applied on this PC yet: `npx agent-cloud sync`, then `--apply --adopt`");
  else if ((head && head !== pc.appliedCommit) || pc.appliedVersion !== packageVersion) warn("changes wait to be applied on this PC: preview with `npx agent-cloud sync`");
  else ok("this PC is up to date with your config");

  const waiter = path.join(pcDir(), "desktop-wait.pid");
  if (existsSync(waiter)) warn("the Claude app's servers are written once you quit the app (tray icon > Quit)");

  storeAppCheck(catalog);
}

/**
 * Windows Store (MSIX) build of the Claude app: a program installed under AppData from a terminal *inside* a Claude
 * session lands in the app's private copy of AppData, so other agents (and terminals outside Claude) can't see it.
 */
function storeAppCheck(catalog: Catalog): void {
  if (process.platform !== "win32") return;
  const packages = path.join(os.homedir(), "AppData", "Local", "Packages");
  const claude = (existsSync(packages) ? readdirSync(packages) : []).filter((n) => /^Claude_/i.test(n));
  if (!claude.length) return;
  const appData = [
    [path.join(os.homedir(), "AppData", "Local"), "Local"],
    [path.join(os.homedir(), "AppData", "Roaming"), "Roaming"],
  ] as const;
  const programs = Object.values(catalog.servers)
    .flatMap((e) => Object.values(e))
    .flatMap((d) => (d && d.type === "stdio" ? [d.command, ...(d.args ?? [])] : []))
    .map((p) => p.replace(/^\$\{home\}/, os.homedir()));
  for (const p of new Set(programs)) {
    for (const [root, kind] of appData) {
      if (!p.toLowerCase().startsWith(root.toLowerCase() + path.sep)) continue;
      const rel = p.slice(root.length + 1);
      for (const pkg of claude) {
        if (existsSync(path.join(packages, pkg, "LocalCache", kind, rel))) {
          console.log(`check    ${p} exists in the Claude app's private copy of AppData (installed from inside a Claude session?); other agents may not find it. Reinstall it from a normal terminal.`);
        }
      }
    }
  }
}
