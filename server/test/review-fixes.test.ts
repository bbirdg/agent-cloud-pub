import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "../src/env";
import { createProject, linkProject, noteToMarkdown, readNotes, saveNote, setStatus, getNote } from "../src/memory";

const a: Actor = { kind: "device", name: "pc-a" };
const b: Actor = { kind: "device", name: "pc-b" };
const BASE = "http://localhost:8787";
const note = (overrides: Record<string, unknown> = {}) => ({
  project: "_global",
  name: "Reply style",
  description: "Short answers",
  type: "user" as const,
  body: "Keep answers short.",
  ...overrides,
});

afterEach(() => vi.restoreAllMocks());

describe("audit only records writes that happened", () => {
  it("logs one update when two agents race on the same version", async () => {
    await saveNote(env.DB, a, note());
    const [first, second] = await Promise.all([
      saveNote(env.DB, a, note({ id: "reply-style", body: "A", expectedVersion: 1 })),
      saveNote(env.DB, b, note({ id: "reply-style", body: "B", expectedVersion: 1 })),
    ]);
    expect([first.ok, second.ok].sort()).toEqual([false, true]);
    const { results } = await env.DB.prepare("SELECT actor FROM audit WHERE action = 'update'").all<{ actor: string }>();
    expect(results).toHaveLength(1);
    const winner = first.ok ? "pc-a" : "pc-b";
    expect(results[0]!.actor).toBe(winner);
  });
});

describe("secrets and credentials never stored", () => {
  it("strips credentials from git remotes in aliases and the audit log", async () => {
    await createProject(env.DB, a, "demo", "Demo");
    await linkProject(env.DB, a, "demo", { gitRemote: "https://x-access-token:ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/me/demo.git" });
    const dump = JSON.stringify(await env.DB.prepare("SELECT detail FROM audit").all()) + JSON.stringify(await env.DB.prepare("SELECT aliases FROM projects").all());
    expect(dump).not.toContain("ghp_");
    expect(dump).toContain("github.com/me/demo");
  });

  it("refuses secrets in mute reasons and project titles", async () => {
    await saveNote(env.DB, a, note());
    await expect(setStatus(env.DB, a, { ref: "_global/reply-style", action: "mute", reason: "key sk-ant-abcdefghijklmnopqrstuvwxyz" })).rejects.toThrow(/secret|key/);
    await expect(createProject(env.DB, a, "x", "token ghp_abcdefghijklmnopqrstuvwxyz0123456789")).rejects.toThrow(/GitHub token/);
  });
});

describe("frontmatter is always valid YAML with string values", () => {
  it("quotes values YAML would misread", async () => {
    const tricky = ["& co", ", list", "&anchor", "true", "123", "0x1F", ".inf", 'say "hi": now'];
    for (const [i, value] of tricky.entries()) {
      await saveNote(env.DB, a, note({ id: `t${i}`, name: value, description: value }));
      const md = noteToMarkdown((await getNote(env.DB, "_global", `t${i}`))!);
      const nameLine = md.split("\n").find((l) => l.startsWith("name: "))!;
      expect(JSON.parse(nameLine.slice(6))).toBe(value);
    }
  });
});

describe("reading many notes stays within the D1 query limit", () => {
  it("reads 20 refs with history in one call", async () => {
    for (let i = 0; i < 20; i++) await saveNote(env.DB, a, note({ id: `n${i}`, name: `Note ${i}` }));
    await saveNote(env.DB, a, note({ id: "n0", name: "Note 0 edited", expectedVersion: 1 }));
    const text = await readNotes(env.DB, Array.from({ length: 20 }, (_, i) => `n${i}`), true);
    expect(text.match(/## _global\/n\d+/g)).toHaveLength(20);
    expect(text).toContain("- v1");
  });
});

describe("sign-in only sends tokens to Claude or this computer", () => {
  it("refuses to register a client with another redirect host", async () => {
    const response = await exports.default.fetch(`${BASE}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "Claude", redirect_uris: ["https://evil.example/cb"], token_endpoint_auth_method: "none" }),
    });
    expect(response.status).toBe(403);
  });

  it("accepts Claude's callback and loopback", async () => {
    for (const uri of ["https://claude.ai/api/mcp/auth_callback", "http://127.0.0.1:33418/callback"]) {
      const response = await exports.default.fetch(`${BASE}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_name: "ok", redirect_uris: [uri], token_endpoint_auth_method: "none" }),
      });
      expect(response.status).toBe(201);
    }
  });
});
