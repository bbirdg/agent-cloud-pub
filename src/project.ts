/**
 * Where things live.
 * - The package (this code): found from this file, works from the source tree and from dist/.
 * - The project: the user's own folder with agent-cloud.json and config/ (their rules, skills, MCP servers).
 *   Found from --project, AGENT_CLOUD_PROJECT, the current folder or its parents, or the last one used on this PC.
 * - This PC: ~/.agent-cloud (what the sync wrote, its state, backups, secrets.json). Never in git.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SETTINGS_FILE = "agent-cloud.json";

/** The user's agent-cloud.json. */
export interface Settings {
  memory: {
    /** Public base URL of the memory server, e.g. https://agent-memory.<account>.workers.dev or https://memory.example.com */
    url: string;
    /** Worker name on Cloudflare. */
    worker: string;
    /** A custom domain the Worker answers on instead of workers.dev (a Cloudflare zone of this account), or null. */
    domain?: string | null;
    d1: { name: string; id: string };
    kv: { id: string };
    compatibilityDate?: string;
  };
  /** owner/name of the GitHub repo holding this project; its memory-backup branch gets the nightly backup. */
  repo?: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));

/** The installed package's root (the folder with its package.json). */
export const packageRoot: string = (() => {
  for (let dir = here; ; dir = path.dirname(dir)) {
    const pkg = path.join(dir, "package.json");
    if (existsSync(pkg) && (JSON.parse(readFileSync(pkg, "utf8")) as { name?: string }).name === "agent-cloud") return dir;
    if (path.dirname(dir) === dir) throw new Error("agent-cloud: can't find its own package folder");
  }
})();

export const packageVersion = (JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as { version: string }).version;

/** How to start this CLI again from a child process (the source tree runs .ts directly, an install runs dist). */
export const cliCommand: [string, ...string[]] = [process.execPath, path.join(here, import.meta.url.endsWith(".ts") ? "cli.ts" : "cli.js")];

export const pcDir = (home = os.homedir()) => path.join(home, ".agent-cloud");

/** Per-PC state: the project last used here, the last applied project commit, and whether agent-cloud is unplugged. */
export interface PcState {
  project?: string;
  appliedCommit?: string;
  /** The agent-cloud version of the last full apply (a newer install may write things differently). */
  appliedVersion?: string;
  at?: string;
  /** "memory": memory left out; "all": nothing of agent-cloud on this PC until `agent-cloud on`. */
  off?: "memory" | "all";
}

export function readPcState(home = os.homedir()): PcState {
  const file = path.join(pcDir(home), "state.json");
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as PcState & { repo?: string };
    // Older versions recorded the project as "repo".
    return { ...s, project: s.project ?? s.repo };
  } catch {
    return {};
  }
}

export function writePcState(state: PcState, home = os.homedir()): void {
  mkdirSync(pcDir(home), { recursive: true });
  const { project, appliedCommit, appliedVersion, at, off } = state;
  writeFileSync(path.join(pcDir(home), "state.json"), JSON.stringify({ project, appliedCommit, appliedVersion, at, ...(off ? { off } : {}) }, null, 2) + "\n");
}

/** The project folder, or null when none can be found. */
export function findProject(explicit?: string, home = os.homedir()): string | null {
  const candidates = [explicit, process.env.AGENT_CLOUD_PROJECT].filter(Boolean) as string[];
  for (const c of candidates) if (existsSync(path.join(c, SETTINGS_FILE))) return path.resolve(c);
  for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, SETTINGS_FILE))) return dir;
    if (path.dirname(dir) === dir) break;
  }
  const last = readPcState(home).project;
  return last && existsSync(path.join(last, SETTINGS_FILE)) ? last : null;
}

export function requireProject(explicit?: string, home = os.homedir()): string {
  const dir = findProject(explicit, home);
  if (!dir) throw new Error(`No agent-cloud project found. Run this inside your agent-cloud folder (the one with ${SETTINGS_FILE}), or create one with: npx agent-cloud init <folder>`);
  return dir;
}

export function readSettings(project: string, opts: { allowNoUrl?: boolean } = {}): Settings {
  const s = JSON.parse(readFileSync(path.join(project, SETTINGS_FILE), "utf8")) as Settings;
  if (!s.memory) throw new Error(`${SETTINGS_FILE}: the "memory" section is missing`);
  if (!s.memory.url && !opts.allowNoUrl) throw new Error(`${SETTINGS_FILE}: memory.url is missing (run: npx agent-cloud setup)`);
  return { ...s, memory: { ...s.memory, url: (s.memory.url ?? "").replace(/\/+$/, "") } };
}

export function writeSettings(project: string, s: Settings): void {
  writeFileSync(path.join(project, SETTINGS_FILE), JSON.stringify(s, null, 2) + "\n");
}

// ---------- secrets ----------
// A value is looked up in the environment, then (Windows) the saved user environment variables, then this PC's
// ~/.agent-cloud/secrets.json. Agents get the values filled into their own local config files, which works the same
// on every OS and for apps started from the desktop, which don't see a shell's variables.

const secretsFile = (home: string) => path.join(pcDir(home), "secrets.json");

export function readSecretsFile(home = os.homedir()): Record<string, string> {
  try {
    return JSON.parse(readFileSync(secretsFile(home), "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

export function saveSecret(name: string, value: string, home = os.homedir()): void {
  const all = { ...readSecretsFile(home), [name]: value };
  mkdirSync(pcDir(home), { recursive: true });
  writeFileSync(secretsFile(home), JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(secretsFile(home), 0o600);
  } catch {
    // Windows: the file sits in the user's own profile
  }
  if (path.resolve(home) === path.resolve(os.homedir())) exportSecret(name, value, all, home);
}

/**
 * Claude Code fills ${NAME} in its MCP servers from its own environment, so a secret also goes there: a Windows user
 * variable (new agent windows see it), or ~/.agent-cloud/env.sh on macOS and Linux (loaded by the shell profile).
 */
function exportSecret(name: string, value: string, all: Record<string, string>, home: string): void {
  if (process.platform === "win32") {
    // Name and value travel in the child's environment, never on its command line.
    execFileSync("powershell", ["-NoProfile", "-Command", "[Environment]::SetEnvironmentVariable($env:AC_NAME, $env:AC_VALUE, 'User')"], {
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, AC_NAME: name, AC_VALUE: value },
    });
    return;
  }
  const sh = Object.entries(all).map(([k, v]) => `export ${k}='${v.replace(/'/g, `'\\''`)}'`);
  writeFileSync(envScript(home), `# Written by agent-cloud: your secrets, for Claude Code. Load it from your shell profile.\n${sh.join("\n")}\n`, { mode: 0o600 });
  chmodSync(envScript(home), 0o600);
}

export const envScript = (home = os.homedir()) => path.join(pcDir(home), "env.sh");

function windowsUserEnv(): Record<string, string> {
  if (process.platform !== "win32") return {};
  try {
    const json = execFileSync("powershell", ["-NoProfile", "-Command", "[Environment]::GetEnvironmentVariables('User') | ConvertTo-Json -Compress"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
    });
    return JSON.parse(json || "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

/** Every value a ${env:NAME} placeholder can resolve to on this PC. `isolated` (test runs) reads only the secrets file. */
export function secretValues(home = os.homedir(), isolated = false): Record<string, string | undefined> {
  const file = readSecretsFile(home);
  return isolated ? file : { ...file, ...windowsUserEnv(), ...process.env };
}
