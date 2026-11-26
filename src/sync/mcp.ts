/**
 * MCP server catalog (config/mcp/catalog.json) and its translation into each harness's format.
 * The catalog never holds a secret, a user name or an address: values say "${env:NAME}" (a secret, see
 * project.ts), "${home}" (the user's folder) and "${memoryUrl}" (the memory server). Each harness's local config
 * gets the real values, which works the same on every OS and for apps started from the desktop.
 */

export type McpDef =
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string>; cwd?: string; extra?: Record<string, unknown> }
  | { type: "http"; url: string; headers?: Record<string, string>; extra?: Record<string, unknown> };

/** name -> { default?: def, <harness>?: def | false }; leaveAlone: servers an app manages itself (never adopted). */
export type Catalog = { leaveAlone?: string[]; servers: Record<string, Record<string, McpDef | false>> };

/** The shared memory server's catalog name (left out while memory is off on a PC). */
export const MEMORY_SERVER = "agent-memory";

const PLACEHOLDER = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;
type Vars = Record<string, string | undefined>;

/** The definition a harness should get, or null when it isn't enabled for that harness. */
export function defFor(entry: Record<string, McpDef | false>, harness: string): McpDef | null {
  if (entry[harness] === false) return null;
  return (entry[harness] as McpDef | undefined) ?? (entry.default as McpDef | undefined) ?? null;
}

const mapStrings = (value: unknown, f: (s: string) => string): unknown =>
  typeof value === "string"
    ? f(value)
    : Array.isArray(value)
      ? value.map((v) => mapStrings(v, f))
      : value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, f)]))
        : value;

/** Every ${env:NAME} replaced by its value. */
export const fill = <T,>(value: T, vars: Vars): T => mapStrings(value, (s) => s.replace(PLACEHOLDER, (_, n: string) => vars[n] ?? "")) as T;

const envNames = (def: McpDef) => [...new Set([...JSON.stringify(def).matchAll(PLACEHOLDER)].map((m) => m[1]!))];

/** A path written for one PC: a drive path on Windows, a rooted path with at least two parts elsewhere. */
const localPath = (s: string, platform: NodeJS.Platform) => (platform === "win32" ? /^[A-Za-z]:[\\/]/ : /^\/[^/\s]+\/\S/).test(s);

export interface Local {
  home: string;
  memoryUrl: string;
  /** Values for ${env:NAME}. */
  secrets: Vars;
}

/**
 * Fits the catalog to this PC: "${home}" and "${memoryUrl}" are filled in; a server whose program or script isn't on
 * this PC, or whose secret isn't set here, is left out (its definition for that harness, or its shared default) with
 * a warning, instead of being written as a server that fails to start. Secrets stay as ${env:NAME} here; each
 * harness's converter fills them in its own way.
 */
export function localize(catalog: Catalog, local: Local, exists: (p: string) => boolean, warn: (m: string) => void, platform: NodeJS.Platform = process.platform): Catalog {
  const servers: Catalog["servers"] = {};
  for (const [name, entry] of Object.entries(catalog.servers)) {
    const out: Record<string, McpDef | false> = {};
    for (const [h, def] of Object.entries(entry)) {
      if (!def) {
        out[h] = def;
        continue;
      }
      // In the slash style of the path it starts: "${home}/.x" keeps forward slashes.
      const d = mapStrings(def, (s) =>
        s.replace(/\$\{home\}(?=(.?))/g, (_, next: string) => (next === "/" ? local.home.replaceAll("\\", "/") : local.home)).replaceAll("${memoryUrl}", local.memoryUrl),
      ) as McpDef;
      const where = `${name}${h === "default" ? "" : ` (${h})`}`;
      const program = d.type === "stdio" ? [d.command, ...(d.args ?? [])].find((p) => localPath(p, platform) && !exists(p)) : undefined;
      const unset = envNames(d).filter((n) => !local.secrets[n]);
      if (program) warn(`${where}: not installed on this PC, left out (${program})`);
      else if (unset.length) warn(`${where}: left out, secret(s) not set on this PC: ${unset.join(", ")} (agent-cloud secret set <NAME>)`);
      if (!program && !unset.length) out[h] = d;
      else if (h !== "default") out[h] = false; // without its default, harnesses that used it get nothing
    }
    servers[name] = out;
  }
  return { ...catalog, servers };
}

// ---------- Claude Code (claude mcp add-json) ----------
export function toClaude(def: McpDef, vars: Vars): Record<string, unknown> {
  const { extra, ...rest } = fill(def, vars);
  return { ...rest, ...(extra ?? {}) };
}

// ---------- Cursor (~/.cursor/mcp.json) ----------
export function toCursor(def: McpDef, vars: Vars): Record<string, unknown> {
  const { type: _type, extra, ...rest } = fill(def, vars);
  return { ...rest, ...(extra ?? {}) };
}

// ---------- Antigravity (~/.gemini/config/mcp_config.json) ----------
export function toAntigravity(def: McpDef, vars: Vars): Record<string, unknown> {
  const { extra, ...rest } = fill(def, vars) as McpDef & { extra?: Record<string, unknown> };
  if (rest.type === "http") {
    const { type: _t, url, ...http } = rest;
    return { serverUrl: url, ...http, ...(extra ?? {}) };
  }
  const { type: _t, ...stdio } = rest;
  return { ...stdio, ...(extra ?? {}) };
}

// ---------- Claude desktop app (claude_desktop_config.json) ----------
/**
 * The app starts local (stdio) servers only; remote ones go through mcp-remote, which fills a header from its own
 * environment, so a header names its variable and the value goes in `env` (no secret on the command line).
 */
export function toClaudeDesktop(name: string, def: McpDef, vars: Vars, platform: NodeJS.Platform = process.platform): Record<string, unknown> {
  if (def.type === "stdio") {
    if ((def.args ?? []).some((a) => a.includes("${env:")) || def.command.includes("${env:")) throw new Error(`${name}: the Claude app can't take a secret inside a command or args; use env`);
    const env = fill(def.env ?? {}, vars);
    return { command: def.command, ...(def.args?.length ? { args: def.args } : {}), ...(Object.keys(env).length ? { env } : {}), ...(def.cwd ? { cwd: def.cwd } : {}) };
  }
  if (def.url.includes("${env:")) throw new Error(`${name}: the Claude app can't take a secret inside a URL; use a header`);
  const env: Record<string, string> = {};
  const headers = Object.entries(def.headers ?? {}).flatMap(([h, v]) => {
    if (!v.includes("${env:")) return ["--header", `${h}:${v}`];
    // The whole value (e.g. "Bearer <token>") goes in one variable: no secret and no space on the command line.
    const n = /^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(v)?.[1] ?? `AGENT_CLOUD_HEADER_${h.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
    env[n] = fill(v, vars);
    return ["--header", `${h}:\${${n}}`];
  });
  const remote = ["-y", "mcp-remote@latest", def.url, ...headers];
  const command = platform === "win32" ? { command: "cmd", args: ["/c", "npx", ...remote] } : { command: "npx", args: remote };
  return { ...command, ...(Object.keys(env).length ? { env } : {}) };
}

// ---------- Codex (~/.codex/config.toml [mcp_servers.<name>]) ----------
/** Returns a TOML table object for the server. */
export function toCodex(def: McpDef, vars: Vars): Record<string, unknown> {
  const d = fill(def, vars);
  const out: Record<string, unknown> = {};
  if (d.type === "stdio") {
    out.command = d.command;
    if (d.args) out.args = d.args;
    if (d.cwd) out.cwd = d.cwd;
    if (d.env && Object.keys(d.env).length) out.env = d.env;
  } else {
    out.url = d.url;
    if (d.headers && Object.keys(d.headers).length) out.http_headers = d.headers;
  }
  return { ...out, ...(d.extra ?? {}) };
}

// ---------- minimal TOML writer for one [mcp_servers.<name>] block ----------
const bareKey = (k: string) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k));

function tomlValue(v: unknown): string {
  if (typeof v === "string") return /[\\'\n]/.test(v) || v.includes("'") ? JSON.stringify(v) : `'${v}'`;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(", ")}]`;
  if (v && typeof v === "object") {
    return `{ ${Object.entries(v)
      .map(([k, x]) => `${bareKey(k)} = ${tomlValue(x)}`)
      .join(", ")} }`;
  }
  throw new Error(`Unsupported TOML value: ${String(v)}`);
}

/** Serializes a server table: scalars/arrays inline, nested plain objects as sub-tables. */
export function tomlBlock(name: string, table: Record<string, unknown>): string {
  const head = `mcp_servers.${bareKey(name)}`;
  const scalars: string[] = [];
  const subs: string[] = [];
  for (const [k, v] of Object.entries(table)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const inner = Object.entries(v as Record<string, unknown>).map(([ik, iv]) => `${bareKey(ik)} = ${tomlValue(iv)}`);
      subs.push(`[${head}.${bareKey(k)}]\n${inner.join("\n")}\n`);
    } else scalars.push(`${bareKey(k)} = ${tomlValue(v)}`);
  }
  return [`[${head}]\n${scalars.join("\n")}\n`, ...subs].join("\n");
}

/** Finds a server's block (its header and its sub-tables) in config.toml text. */
export function findTomlBlock(text: string, name: string): { start: number; end: number } | null {
  const lines = text.split("\n");
  const head = new RegExp(`^\\[mcp_servers\\.(?:"${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"|${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(\\]|\\.)`);
  let startLine = -1;
  let endLine = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (startLine < 0) {
      if (head.test(line)) startLine = i;
      continue;
    }
    if (/^\s*\[/.test(line) && !head.test(line)) {
      endLine = i;
      break;
    }
  }
  if (startLine < 0) return null;
  // Leave trailing blank lines to the next block.
  while (endLine > startLine + 1 && lines[endLine - 1]!.trim() === "") endLine--;
  const offset = (n: number) => lines.slice(0, n).reduce((a, l) => a + l.length + 1, 0);
  return { start: offset(startLine), end: offset(endLine) };
}
