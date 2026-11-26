import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import { main as init } from "../src/init.ts";

export const TOKEN = "amem_test-token-0123456789abcdefghijklmnopqrstu";

/** A fresh project (from the template) and a fresh home with a device token; removed by cleanup(). */
export async function world(): Promise<{ root: string; project: string; home: string; cleanup: () => void }> {
  const root = mkdtempSync(path.join(os.tmpdir(), "agent-cloud-test-"));
  const project = path.join(root, "project");
  const home = path.join(root, "home");
  await quiet(() => init([project, "--no-install"]));
  const settingsFile = path.join(project, "agent-cloud.json");
  const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
  settings.memory = { ...settings.memory, url: "https://memory.example.com", d1: { name: "agent-memory", id: "d1-id" }, kv: { id: "kv-id" } };
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  mkdirSync(path.join(home, ".agent-cloud"), { recursive: true });
  writeFileSync(path.join(home, ".agent-cloud", "secrets.json"), JSON.stringify({ AGENT_MEMORY_TOKEN: TOKEN }));
  return { root, project, home, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Runs fn with console output captured; returns it. */
export async function quiet(fn: () => Promise<unknown> | unknown): Promise<string> {
  const lines: string[] = [];
  const capture = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  const log = vi.spyOn(console, "log").mockImplementation(capture);
  const warn = vi.spyOn(console, "warn").mockImplementation(capture);
  const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => (lines.push(String(chunk)), true));
  try {
    await fn();
  } finally {
    log.mockRestore();
    warn.mockRestore();
    write.mockRestore();
  }
  return lines.join("\n");
}

/**
 * Every file under home (except agent-cloud's own state and backups), relative path -> content. JSON objects and
 * TOML server tables are compared without their order (re-adding a server puts it last; agents don't care).
 */
export function snapshot(home: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir)) {
      const r = rel ? `${rel}/${name}` : name;
      if (r === ".agent-cloud" || /\.bak-/.test(name)) continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full, r);
      else out[r] = canonical(name, readFileSync(full, "utf8"));
    }
  };
  walk(home, "");
  return out;
}

function canonical(name: string, text: string): string {
  const sorted = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])])) : v;
  if (name.endsWith(".json")) return JSON.stringify(sorted(JSON.parse(text)), null, 2);
  if (name.endsWith(".toml")) return text.split(/\n(?=\[mcp_servers\.[^.\]]+\]\n)/).map((b) => b.trim()).sort().join("\n\n");
  return text;
}
