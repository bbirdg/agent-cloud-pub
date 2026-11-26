/**
 * Brings MCP servers that were added straight to an agent into config/mcp/catalog.json, as-is, and moves secrets
 * typed into their configs into this PC's ~/.agent-cloud/secrets.json (values are never printed). Servers already
 * in the catalog, or listed in its "leaveAlone" (servers an app manages itself), are never touched. A new server
 * identical everywhere becomes a shared `default`; otherwise it keeps one definition per harness. Paths in the
 * user's folder are written as ${home}, the memory server's address as ${memoryUrl}.
 *
 *   agent-cloud adopt-mcp                 # preview
 *   agent-cloud adopt-mcp --write         # add them to catalog.json and save the secrets
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readSecretsFile, readSettings, requireProject, saveSecret } from "../project.ts";
import type { Catalog, McpDef } from "./mcp.ts";

const args = process.argv.slice(2);
const write = args.includes("--write");
const home = os.homedir();
const project = requireProject(args.includes("--project") ? args[args.indexOf("--project") + 1] : undefined);
const memoryUrl = readSettings(project).memory.url;
const readJson = (p: string) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {});

const secrets = new Map<string, string>(); // env name -> value
const notes: string[] = [];

function remember(name: string, value: string, where: string): string {
  const prev = secrets.get(name);
  if (prev && prev !== value) notes.push(`${name}: a different value was found in ${where}; kept the first one`);
  if (!prev) secrets.set(name, value);
  return `\${env:${name}}`;
}

// Names of the variables these servers' keys already live in (set on every PC; see README).
const envNameFor = (server: string, key: string) =>
  ({ context7: "CONTEXT7_API_KEY", stitch: "STITCH_API_KEY", "agent-memory": "AGENT_MEMORY_TOKEN" })[server] ??
  `${server}_${key}`.toUpperCase().replace(/[^A-Z0-9]+/g, "_");

/** A path inside the user's folder, written so it works for any user name; the memory server as ${memoryUrl}. */
const homeRel = (s: string) =>
  s.startsWith(memoryUrl) ? "${memoryUrl}" + s.slice(memoryUrl.length) : s.toLowerCase().startsWith(home.toLowerCase()) && /^[\\/]|^$/.test(s.slice(home.length)) ? "${home}" + s.slice(home.length) : s;

const SECRET_KEY = /(api[_-]?key|token|secret|password|authorization)/i;
const looksSecret = (key: string, v: string) => SECRET_KEY.test(key) && v.length >= 12 && !v.includes("${");

/** Normalizes one server from any harness's format into an McpDef with secrets replaced by ${env:...}. */
function normalize(server: string, raw: Record<string, any>, where: string): McpDef {
  const known = new Set(["type", "transport", "command", "args", "env", "env_vars", "cwd", "url", "serverUrl", "httpUrl", "headers", "http_headers", "env_http_headers", "bearer_token_env_var"]);
  const extra = Object.fromEntries(Object.entries(raw).filter(([k]) => !known.has(k)));
  const url: string | undefined = raw.url ?? raw.serverUrl ?? raw.httpUrl;
  if (url) {
    const headers: Record<string, string> = {};
    for (const [h, v] of Object.entries({ ...(raw.headers ?? {}), ...(raw.http_headers ?? {}) })) {
      const value = String(v);
      const bearer = /^Bearer (.{12,})$/.exec(value);
      if (bearer && !bearer[1]!.includes("${")) headers[h] = `Bearer ${remember(envNameFor(server, h), bearer[1]!, where)}`;
      else if (looksSecret(h, value)) headers[h] = remember(envNameFor(server, h), value, where);
      else headers[h] = value.replace(/\$\{(?!env:)([A-Za-z_][A-Za-z0-9_]*)\}/g, "${env:$1}");
    }
    for (const [h, v] of Object.entries(raw.env_http_headers ?? {})) headers[h] = `\${env:${v}}`;
    if (raw.bearer_token_env_var) headers.Authorization = `Bearer \${env:${raw.bearer_token_env_var}}`;
    let cleanUrl = url;
    const u = new URL(url);
    for (const [k, v] of [...u.searchParams]) {
      if (/api[_-]?key|token/i.test(k) && v.length >= 12) {
        u.searchParams.delete(k);
        headers[k] = remember(envNameFor(server, k), v, where);
        cleanUrl = u.toString().replace(/\?$/, "");
      }
    }
    return { type: "http", url: cleanUrl, ...(Object.keys(headers).length ? { headers } : {}), ...(Object.keys(extra).length ? { extra } : {}) };
  }
  const args: string[] = [...(raw.args ?? [])].map(String);
  const env: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    // A key inside one combined argument, e.g. cmd /c "npx -y pkg --api-key KEY".
    const inline = /\s--?api-?key[ =](\S+)/i.exec(args[i]!);
    if (inline) {
      const name = envNameFor(server, "api_key");
      env[name] = remember(name, inline[1]!, where);
      args[i] = args[i]!.replace(inline[0], "");
      continue;
    }
    if (/^--?api-?key$/i.test(args[i]!) && args[i + 1]) {
      const name = envNameFor(server, "api_key");
      env[name] = remember(name, args[i + 1]!, where);
      args.splice(i, 2);
      i--;
    }
  }
  for (const [k, v] of Object.entries(raw.env ?? {})) env[k] = looksSecret(k, String(v)) ? remember(k, String(v), where) : homeRel(String(v));
  for (const k of raw.env_vars ?? []) env[typeof k === "string" ? k : k.name] = `\${env:${typeof k === "string" ? k : k.name}}`;
  return {
    type: "stdio",
    command: homeRel(String(raw.command)),
    ...(raw.args !== undefined ? { args: args.map(homeRel) } : {}),
    ...(Object.keys(env).length ? { env } : {}),
    ...(raw.cwd ? { cwd: raw.cwd } : {}),
    ...(Object.keys(extra).length ? { extra } : {}),
  };
}

// ---------- read the servers each harness has that the catalog doesn't ----------
const out = path.join(project, "config", "mcp", "catalog.json");
const catalog: Catalog = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : { servers: {} };
const skip = new Set([...Object.keys(catalog.servers), ...(catalog.leaveAlone ?? [])]);
const perHarness: Record<string, Record<string, McpDef>> = { "claude-code": {}, codex: {}, cursor: {}, antigravity: {} };
const take = (harness: string, servers: Record<string, any>, where: string) => {
  for (const [n, s] of Object.entries(servers)) if (!skip.has(n)) perHarness[harness]![n] = normalize(n, s, where);
};

take("claude-code", readJson(path.join(home, ".claude.json")).mcpServers ?? {}, "Claude Code");
const codexConfig = path.join(home, ".codex", "config.toml");
if (existsSync(codexConfig)) {
  // Python's tomllib reads Codex's TOML; without Python, Codex's servers are skipped (reported, nothing breaks).
  for (const python of process.platform === "win32" ? ["python", "py"] : ["python3", "python"]) {
    try {
      const json = execFileSync(python, ["-I", "-c", "import json,sys,tomllib;print(json.dumps(tomllib.load(open(sys.argv[1],'rb')).get('mcp_servers',{})))", codexConfig], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      take("codex", JSON.parse(json), "Codex");
      break;
    } catch {
      if (python === (process.platform === "win32" ? "py" : "python")) notes.push("Codex: skipped (reading its config.toml needs Python 3.11+)");
    }
  }
}
take("cursor", readJson(path.join(home, ".cursor", "mcp.json")).mcpServers ?? {}, "Cursor");
take("antigravity", readJson(path.join(home, ".gemini", "config", "mcp_config.json")).mcpServers ?? {}, "Antigravity");

// ---------- add the new servers to the catalog ----------
const names = [...new Set(Object.values(perHarness).flatMap((m) => Object.keys(m)))].sort();
for (const name of names) {
  const defs = Object.entries(perHarness).filter(([, m]) => m[name]).map(([h, m]) => [h, m[name]!] as const);
  const same = defs.every(([, d]) => JSON.stringify(d) === JSON.stringify(defs[0]![1]));
  const entry: Record<string, McpDef | false> = {};
  if (same && defs.length > 1) {
    entry.default = defs[0]![1];
    for (const h of Object.keys(perHarness)) if (!perHarness[h]![name]) entry[h] = false;
  } else for (const [h, d] of defs) entry[h] = d;
  catalog.servers[name] = entry;
}

console.log(`New servers: ${names.join(", ") || "none"}`);
console.log(`Secrets moved to this PC's secrets file: ${[...secrets.keys()].join(", ") || "none"}`);
for (const n of notes) console.log(`note: ${n}`);

if (write) {
  const saved = readSecretsFile(home);
  for (const [name, value] of secrets) if (saved[name] !== value) saveSecret(name, value, home);
  if (names.length) {
    catalog.servers = Object.fromEntries(Object.entries(catalog.servers).sort(([a], [b]) => a.localeCompare(b)));
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(catalog, null, 2) + "\n");
  }
  console.log(`Added ${names.length} server(s) to ${path.relative(project, out)} and saved ${secrets.size} secret(s).`);
}
