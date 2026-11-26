import { describe, expect, it } from "vitest";
import { env, exports } from "cloudflare:workers";
import { MAX_FILE_BYTES, MAX_SKILL_BYTES, applyServeRule, globalRulesSkill, selectSkills, skillsJson } from "../src/skills-select";
import { loadSkillCatalog, skillCatalog } from "../src/skills-source";
import { BASE, TOKEN, addDevice, rpc } from "./helpers";

describe("the skills file is private", () => {
  it("is never served as a public file, only through the SKILLS binding", async () => {
    for (const p of ["/skills.json", "/assets/skills.json", "/SKILLS/skills.json"]) {
      const response = await exports.default.fetch(`${BASE}${p}`);
      expect(response.status, p).toBe(404);
      expect(await response.text(), p).not.toContain("fixture-skill");
    }
    // ...while the binding itself does hold it.
    expect(await (await env.SKILLS!.fetch("https://assets.local/skills.json")).text()).toContain("fixture-skill");
  });
});

const enc = (s: string) => new TextEncoder().encode(s);
const skillMd = (name: string, body = "Body.") => enc(`---\nname: ${name}\ndescription: The ${name} skill.\n---\n\n${body}\n`);

const uris = (catalog: Awaited<ReturnType<typeof loadSkillCatalog>>) => catalog.entries.map((s) => s.uri).sort();
const assetsServing = (response: () => Response) => ({ fetch: async () => response() }) as unknown as Fetcher;

describe("skills catalog", () => {
  it("serves the skills from the SKILLS assets and agent-memory", async () => {
    const catalog = await skillCatalog(env);
    expect(uris(catalog)).toEqual(["skill://agent-memory/SKILL.md", "skill://fixture-skill/SKILL.md"]);

    await addDevice("skills-pc", TOKEN);
    const listed = JSON.stringify((await rpc(TOKEN, "skills/list")).json.result);
    expect(listed).toContain("agent-memory");
    expect(listed).toContain("fixture-skill");
  });

  it("loads what skillsJson writes, and keeps its own agent-memory", async () => {
    const { files, skipped } = await selectSkills([{ name: "demo", files: [{ path: "SKILL.md", bytes: skillMd("demo") }, { path: "notes.md", bytes: enc("# Notes") }] }]);
    expect(skipped).toEqual([]);
    const json = skillsJson({ ...files, "agent-memory/SKILL.md": new TextDecoder().decode(skillMd("agent-memory")) });
    expect(skillsJson(JSON.parse(json).files)).toBe(json);
    const catalog = await loadSkillCatalog(assetsServing(() => new Response(json)));
    expect(uris(catalog)).toEqual(["skill://agent-memory/SKILL.md", "skill://demo/SKILL.md"]);
    expect(JSON.stringify(catalog.entries)).toContain("The demo skill.");
    expect(JSON.stringify(catalog.entries)).not.toContain("The agent-memory skill.");
  });

  it("serves agent-memory only without the binding or the file, and fails on a broken file", async () => {
    expect(uris(await loadSkillCatalog(undefined))).toEqual(["skill://agent-memory/SKILL.md"]);
    expect(uris(await loadSkillCatalog(assetsServing(() => new Response("Not found", { status: 404 }))))).toEqual(["skill://agent-memory/SKILL.md"]);
    await expect(loadSkillCatalog(assetsServing(() => new Response("{", { status: 200 })))).rejects.toThrow();
    await expect(loadSkillCatalog(assetsServing(() => Response.json({ files: { "x/SKILL.md": 1 } })))).rejects.toThrow("not text");
  });
});

describe("skill selection: never serves hidden files or secrets", () => {
  it("skips a skill with a dotfile or a file that looks like it holds a key", async () => {
    const { files, skipped } = await selectSkills([
      { name: "dotfile", files: [{ path: "SKILL.md", bytes: skillMd("dotfile") }, { path: ".env", bytes: enc("X=1") }] },
      { name: "keyed", files: [{ path: "SKILL.md", bytes: skillMd("keyed", "token ghp_abcdefghijklmnopqrstuvwxyz0123456789") }] },
      { name: "clean", files: [{ path: "SKILL.md", bytes: skillMd("clean") }] },
    ]);
    expect(Object.keys(files)).toEqual(["clean/SKILL.md"]);
    expect(skipped.map((s) => s.name).sort()).toEqual(["dotfile", "keyed"]);
  });
});

describe("skill selection", () => {
  it("keeps valid skills and skips oversized, binary, reserved and invalid ones", async () => {
    const { files, skipped } = await selectSkills([
      { name: "demo", files: [{ path: "SKILL.md", bytes: skillMd("demo") }, { path: "references\\guide.md", bytes: enc("# Guide") }] },
      { name: "big-file", files: [{ path: "SKILL.md", bytes: skillMd("big-file") }, { path: "data.md", bytes: new Uint8Array(MAX_FILE_BYTES + 1).fill(97) }] },
      {
        name: "big-total",
        files: [
          { path: "SKILL.md", bytes: skillMd("big-total") },
          ...Array.from({ length: 5 }, (_, i) => ({ path: `part-${i}.md`, bytes: new Uint8Array(Math.ceil(MAX_SKILL_BYTES / 5)).fill(97) })),
        ],
      },
      { name: "binary", files: [{ path: "SKILL.md", bytes: skillMd("binary") }, { path: "icon.png", bytes: new Uint8Array([137, 80, 78, 71, 0, 1]) }] },
      { name: "agent-memory", files: [{ path: "SKILL.md", bytes: skillMd("agent-memory") }] },
      { name: "no-frontmatter", files: [{ path: "SKILL.md", bytes: enc("just text") }] },
    ]);
    expect(Object.keys(files).sort()).toEqual(["demo/SKILL.md", "demo/references/guide.md"]);
    expect(Object.fromEntries(skipped.map((s) => [s.name, s.reason]))).toMatchObject({
      "big-file": expect.stringContaining("data.md is over 100 KB"),
      "big-total": expect.stringContaining("over 400 KB in total"),
      binary: expect.stringContaining("icon.png is binary"),
      "agent-memory": "reserved name",
      "no-frontmatter": expect.stringContaining("invalid"),
    });
  });

  it("keeps a CRLF skill (Windows checkout) and stores it with LF line ends", async () => {
    const crlf = enc("---\r\nname: win\r\ndescription: Written on Windows.\r\n---\r\n\r\nLine one.\r\nLine two.\r\n");
    const { files, skipped } = await selectSkills([{ name: "win", files: [{ path: "SKILL.md", bytes: crlf }] }]);
    expect(skipped).toEqual([]);
    expect(files["win/SKILL.md"]).toBe("---\nname: win\ndescription: Written on Windows.\n---\n\nLine one.\nLine two.\n");
  });

  it("serves a skill without its excluded folders and with the note under its frontmatter", async () => {
    const shaped = applyServeRule(
      {
        name: "big",
        files: [
          { path: "SKILL.md", bytes: skillMd("big", "Guide.") },
          { path: "rules\\a.md", bytes: enc("# A") },
          { path: "engine\\run.js", bytes: new Uint8Array(MAX_FILE_BYTES + 1).fill(97) },
          { path: "engineering.md", bytes: enc("kept: only the engine/ folder is excluded") },
        ],
      },
      { exclude: ["engine/"], note: "Served without its engine." },
    );
    const { files, skipped } = await selectSkills([shaped]);
    expect(skipped).toEqual([]);
    expect(Object.keys(files).sort()).toEqual(["big/SKILL.md", "big/engineering.md", "big/rules/a.md"]);
    expect(files["big/SKILL.md"]).toMatch(/^---\nname: big\ndescription: The big skill\.\n---\n\n> Served without its engine\.\n\nGuide\./);
    expect(applyServeRule(shaped, undefined)).toBe(shaped);
  });

  it("turns global.md into a valid global-rules skill", async () => {
    const md = globalRulesSkill("---\nold: frontmatter\n---\n# Global\r\n\r\n- Rule one\r\n");
    expect(md).toMatch(/^---\nname: global-rules\ndescription: The user's global working rules for every agent/);
    expect(md).toContain("# Global\n\n- Rule one");
    expect(md).not.toContain("old: frontmatter");
    const { files, skipped } = await selectSkills([{ name: "global-rules", builtIn: true, files: [{ path: "SKILL.md", bytes: enc(md) }] }]);
    expect(skipped).toEqual([]);
    expect(Object.keys(files)).toEqual(["global-rules/SKILL.md"]);
  });
});
