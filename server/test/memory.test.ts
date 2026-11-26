import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Actor } from "../src/env";
import {
  MemoryError,
  buildContext,
  createProject,
  getNote,
  linkProject,
  normalizeRemote,
  noteToMarkdown,
  parseNoteMarkdown,
  readNotes,
  saveNote,
  searchNotes,
  setStatus,
} from "../src/memory";
import { findSecret } from "../src/secrets";

const codex: Actor = { kind: "device", name: "codex-pc" };
const claude: Actor = { kind: "device", name: "claude-code-pc" };
const db = () => env.DB;

async function seedProject(key = "skyline") {
  await createProject(db(), codex, key, key === "skyline" ? "Skyline" : key);
  await linkProject(db(), codex, key, { cwd: String.raw`C:\Users\Dev\Code\- Projects\Skyline` });
}

const note = (overrides: Partial<Parameters<typeof saveNote>[2]> = {}) => ({
  project: "skyline",
  name: "URP render pipeline",
  description: "Skyline uses URP, not the built-in pipeline",
  type: "project" as const,
  body: "Skyline switched to URP on 2026-10-01.\n**Why:** mobile performance.",
  ...overrides,
});

describe("saving and reading", () => {
  it("creates a note with a slug id and reads it back byte for byte", async () => {
    await seedProject();
    const body = 'Quotes "double" and \'single\', backticks `code`, ```fence```, and $dollar.\n';
    const result = await saveNote(db(), codex, note({ body }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.note.id).toBe("urp-render-pipeline");
    expect((await getNote(db(), "skyline", "urp-render-pipeline"))!.body).toBe(body);
    const read = await readNotes(db(), ["skyline/urp-render-pipeline"]);
    expect(read).toContain(body);
    expect(read).toContain('updated_by: "codex-pc"');
  });

  it("refuses an update without expected_version and reports a conflict on a stale version", async () => {
    await seedProject();
    await saveNote(db(), codex, note());
    await expect(saveNote(db(), claude, note({ id: "urp-render-pipeline", body: "changed" }))).rejects.toThrow(/expected_version=1/);

    const first = await saveNote(db(), claude, note({ id: "urp-render-pipeline", body: "edit A", expectedVersion: 1 }));
    expect(first.ok && first.note.version).toBe(2);
    const second = await saveNote(db(), codex, note({ id: "urp-render-pipeline", body: "edit B", expectedVersion: 1 }));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.conflict.body).toBe("edit A");
    expect((await getNote(db(), "skyline", "urp-render-pipeline"))!.body).toBe("edit A");
  });

  it("refuses secrets", async () => {
    await seedProject();
    await expect(saveNote(db(), codex, note({ body: "token is ghp_abcdefghijklmnopqrstuvwxyz0123456789" }))).rejects.toThrow(MemoryError);
    await expect(saveNote(db(), codex, note({ body: "api_key = 9f8e7d6c5b4a39281706" }))).rejects.toThrow(/secret/);
    expect(findSecret("live theme 123456789012, ask before push")).toBeNull();
    expect(findSecret("the password is stored in 1Password")).toBeNull();
  });

  it("rejects unknown projects and bad types", async () => {
    await expect(saveNote(db(), codex, note({ project: "nope" }))).rejects.toThrow(/No project 'nope'/);
    await seedProject();
    await expect(saveNote(db(), codex, note({ type: "secret" as never }))).rejects.toThrow(/type must be/);
  });
});

describe("backup format round trip", () => {
  it("parses exactly what noteToMarkdown writes, for any body ending and status", async () => {
    await seedProject();
    const bodies = ["no trailing newline", "one trailing\n", "two trailing\n\n", "\nleading newline", 'quotes "x" and: colons'];
    for (const [i, body] of bodies.entries()) {
      await saveNote(db(), codex, note({ id: `rt${i}`, name: `true`, description: `123: & co`, body }));
    }
    await setStatus(db(), codex, { ref: "skyline/rt1", action: "mute", reason: 'paused: "Nov"' });
    for (let i = 0; i < bodies.length; i++) {
      const n = (await getNote(db(), "skyline", `rt${i}`))!;
      const parsed = parseNoteMarkdown(noteToMarkdown(n), true);
      expect(parsed).toMatchObject({ name: n.name, description: n.description, type: n.type, body: n.body, status: n.status });
      expect(parsed.statusReason ?? null).toBe(n.status_reason);
      expect(parsed.createdAt).toBe(n.created_at);
    }
  });
});

describe("search", () => {
  it("finds English and Arabic text, prefix matching, and skips muted notes", async () => {
    await seedProject();
    await saveNote(db(), codex, note());
    await saveNote(
      db(),
      codex,
      note({ name: "Billiards wording", description: "Say البلياردو with ال", type: "feedback", body: "استخدم كلمة البلياردو دائماً" }),
    );
    expect((await searchNotes(db(), { query: "URP" })).map((h) => h.id)).toContain("urp-render-pipeline");
    expect((await searchNotes(db(), { query: "البلياردو" })).map((h) => h.id)).toContain("billiards-wording");
    expect((await searchNotes(db(), { query: "pipel" })).map((h) => h.id)).toContain("urp-render-pipeline");

    await setStatus(db(), codex, { ref: "skyline/urp-render-pipeline", action: "mute", reason: "paused" });
    expect(await searchNotes(db(), { query: "URP" })).toHaveLength(0);
    expect(await searchNotes(db(), { query: "URP", includeMuted: true })).toHaveLength(1);
  });
});

describe("status changes", () => {
  it("mutes, deletes, restores and rolls back with versions kept", async () => {
    await seedProject();
    await saveNote(db(), codex, note());
    await saveNote(db(), codex, note({ id: "urp-render-pipeline", body: "second text", expectedVersion: 1 }));

    let n = await setStatus(db(), claude, { ref: "skyline/urp-render-pipeline", action: "mute", reason: "Nov campaign" });
    expect([n.status, n.status_reason]).toEqual(["muted", "Nov campaign"]);
    n = await setStatus(db(), claude, { ref: "skyline/urp-render-pipeline", action: "delete" });
    expect(n.status).toBe("deleted");
    n = await setStatus(db(), claude, { ref: "skyline/urp-render-pipeline", action: "restore" });
    expect(n.status).toBe("active");

    const history = await readNotes(db(), ["skyline/urp-render-pipeline"], true);
    expect(history).toContain("v1");
    n = await setStatus(db(), claude, { ref: "skyline/urp-render-pipeline", action: "rollback", toVersion: 1 });
    expect(n.body).toBe(note().body);
    expect(n.version).toBe(6);
  });

  it("needs a full project/id reference", async () => {
    await expect(setStatus(db(), codex, { ref: "urp-render-pipeline", action: "delete" })).rejects.toThrow(/project\/id/);
  });
});

describe("session context", () => {
  it("resolves a subfolder of a linked project and lists project then global notes", async () => {
    await seedProject();
    await saveNote(db(), codex, note());
    await saveNote(db(), codex, note({ project: "_global", name: "Reply language", description: "Answer in English", type: "user", body: "x" }));
    const ctx = await buildContext(db(), { cwd: String.raw`c:\users\dev\code\- projects\skyline\Assets\Scripts` });
    expect(ctx).toContain("# Agent memory — Skyline (skyline)");
    expect(ctx.indexOf("(skyline/urp-render-pipeline)")).toBeLessThan(ctx.indexOf("(_global/reply-language)"));
    expect(ctx).toContain("Recent memory changes");
  });

  it("keeps global rules and stays within budget when a project is huge", async () => {
    await seedProject();
    await saveNote(db(), codex, note({ project: "_global", name: "Never control cursor", description: "x", type: "feedback", body: "x" }));
    const long = "d".repeat(700);
    const stmts = Array.from({ length: 260 }, (_, i) =>
      db().prepare("INSERT INTO notes (project, id, name, description, type, body) VALUES ('skyline', ?, ?, ?, 'project', 'b')").bind(`n${i}`, `Note ${i}`, long),
    );
    await db().batch(stmts);
    const ctx = await buildContext(db(), { project: "skyline" });
    expect(ctx).toContain("(_global/never-control-cursor)");
    expect(ctx).toMatch(/\(\+\d+ more not shown; use memory_search\)/);
    expect(new TextEncoder().encode(ctx).length).toBeLessThan(26 * 1024);
    expect(ctx).not.toContain("d".repeat(200));
  });

  it("never guesses for an unknown folder or no folder", async () => {
    await seedProject();
    const unknown = await buildContext(db(), { cwd: "D:/elsewhere/project" });
    expect(unknown).toContain("not linked to a project");
    expect(unknown).toContain("- skyline — Skyline");
    const none = await buildContext(db(), {});
    expect(none).toContain("No folder given");
    const named = await buildContext(db(), { project: "skyline" });
    expect(named).toContain("Skyline (skyline)");
  });

  it("matches git remotes in any URL form", async () => {
    await seedProject();
    await linkProject(db(), codex, "skyline", { gitRemote: "git@github.com:Me/Skyline.git" });
    expect(normalizeRemote("https://github.com/me/skyline")).toBe("github.com/me/skyline");
    const ctx = await buildContext(db(), { gitRemote: "https://github.com/me/skyline.git" });
    expect(ctx).toContain("(skyline)");
  });
});
