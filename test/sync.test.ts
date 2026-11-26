import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main as offOn } from "../src/off.ts";
import { desktopConfigPath } from "../src/sync/desktop.ts";
import { main as sync } from "../src/sync/sync.ts";
import { quiet, snapshot, TOKEN, world } from "./helpers.ts";

let w: Awaited<ReturnType<typeof world>>;
afterEach(() => w?.cleanup());

const run = (...a: string[]) => quiet(() => sync([...a, "--project", w.project, "--home", w.home]));
const json = (f: string) => JSON.parse(readFileSync(path.join(w.home, f), "utf8"));

describe("sync into a fresh home", () => {
  it("writes every agent's rules, skills, subagents, hook and MCP servers, then changes nothing on a second run", async () => {
    w = await world();
    const preview = await run();
    expect(preview).toContain("Preview (nothing written");
    expect(existsSync(path.join(w.home, ".claude", "CLAUDE.md"))).toBe(false);

    await run("--apply");
    const claudeMd = readFileSync(path.join(w.home, ".claude", "CLAUDE.md"), "utf8");
    expect(claudeMd).toContain("# Global instructions");
    expect(claudeMd).toContain("## Claude Code only");
    expect(claudeMd).toContain("https://memory.example.com/mcp");
    for (const f of [".codex/AGENTS.md", ".gemini/AGENTS.md"]) expect(readFileSync(path.join(w.home, f), "utf8")).toContain("agent-memory:start");
    for (const d of [".claude/skills", ".agents/skills", ".gemini/config/skills"]) {
      expect(existsSync(path.join(w.home, d, "agent-memory", "SKILL.md"))).toBe(true);
      expect(existsSync(path.join(w.home, d, "example-skill", "SKILL.md"))).toBe(true);
    }
    expect(existsSync(path.join(w.home, ".claude", "agents", "reviewer.md"))).toBe(true);
    expect(existsSync(path.join(w.home, ".codex", "agents", "reviewer.toml"))).toBe(true);

    // Claude Code: hook, built-in memory off, MCP servers with the token filled in (test runs write the file).
    const settings = json(".claude/settings.json");
    expect(settings.autoMemoryEnabled).toBe(false);
    expect(JSON.stringify(settings.hooks.SessionStart)).toContain(" hook");
    const claudeJson = json(".claude.json");
    expect(claudeJson.mcpServers["agent-memory"]).toEqual({ type: "http", url: "https://memory.example.com/mcp", headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(claudeJson.mcpServers.context7.url).toBe("https://mcp.context7.com/mcp");
    expect(readFileSync(path.join(w.home, ".codex", "config.toml"), "utf8")).toContain(`Authorization = 'Bearer ${TOKEN}'`);
    expect(json(".gemini/config/mcp_config.json").mcpServers["agent-memory"].serverUrl).toBe("https://memory.example.com/mcp");
    expect(json(".cursor/mcp.json").mcpServers.context7.url).toBe("https://mcp.context7.com/mcp");
    // The Claude app: only the servers listed for it.
    const desktop = JSON.parse(readFileSync(desktopConfigPath(w.home), "utf8")).mcpServers;
    expect(Object.keys(desktop)).toEqual(["context7"]);
    expect(desktop.context7.args).toContain("https://mcp.context7.com/mcp");

    const before = snapshot(w.home);
    const again = await run("--apply");
    expect(again).not.toMatch(/^(create|update|remove|conflict) /m);
    expect(snapshot(w.home)).toEqual(before);
  });

  it("leaves out a server whose secret isn't set on this PC, with a warning", async () => {
    w = await world();
    writeFileSync(path.join(w.home, ".agent-cloud", "secrets.json"), "{}");
    const out = await run("--apply");
    expect(out).toContain("agent-memory: left out, secret(s) not set on this PC: AGENT_MEMORY_TOKEN");
    expect(json(".claude.json").mcpServers["agent-memory"]).toBeUndefined();
    expect(json(".claude.json").mcpServers.context7).toBeDefined();
  });

  it("leaves out a server whose program isn't on this PC", async () => {
    w = await world();
    const catalogFile = path.join(w.project, "config", "mcp", "catalog.json");
    const catalog = JSON.parse(readFileSync(catalogFile, "utf8"));
    const missing = process.platform === "win32" ? "${home}\\.tools\\nope.exe" : "${home}/.tools/nope";
    catalog.servers.local = { default: { type: "stdio", command: missing } };
    writeFileSync(catalogFile, JSON.stringify(catalog));
    const out = await run("--apply");
    expect(out).toMatch(/local: not installed on this PC, left out/);
    expect(json(".claude.json").mcpServers.local).toBeUndefined();
  });

  it("never overwrites a file that existed before, unless adopted (then it's backed up)", async () => {
    w = await world();
    const mine = path.join(w.home, ".codex", "AGENTS.md");
    parentOf(mine);
    writeFileSync(mine, "my own rules\n");
    const out = await run("--apply");
    expect(out).toMatch(/unmanaged codex:rules/);
    expect(readFileSync(mine, "utf8")).toBe("my own rules\n");
    await run("--apply", "--adopt");
    expect(readFileSync(mine, "utf8")).toContain("# Global instructions");
  });
});

describe("off and on (per PC)", () => {
  it("off all removes everything agent-cloud wrote; on brings back exactly the same files", async () => {
    w = await world();
    await run("--apply");
    const before = snapshot(w.home);

    await quiet(() => offOn("off", ["all", "--project", w.project, "--home", w.home]));
    const off = snapshot(w.home);
    for (const f of [".claude/CLAUDE.md", ".codex/AGENTS.md", ".gemini/AGENTS.md", ".claude/skills/example-skill/SKILL.md", ".claude/agents/reviewer.md"]) expect(off[f]).toBeUndefined();
    expect(Object.keys(json(".claude.json").mcpServers ?? {})).toEqual([]);
    expect(json(".claude/settings.json")).toEqual({});
    expect(JSON.parse(readFileSync(desktopConfigPath(w.home), "utf8")).mcpServers).toEqual({});
    expect(JSON.parse(readFileSync(path.join(w.home, ".agent-cloud", "state.json"), "utf8")).off).toBe("all");
    // A sync while off keeps it off.
    expect(await run("--apply")).toContain("agent-cloud is off on this PC");
    expect(existsSync(path.join(w.home, ".claude", "CLAUDE.md"))).toBe(false);

    await quiet(() => offOn("on", ["--project", w.project, "--home", w.home]));
    expect(snapshot(w.home)).toEqual(before);
  });

  it("off memory keeps rules, skills and other servers but drops everything memory", async () => {
    w = await world();
    await run("--apply");
    const before = snapshot(w.home);

    await quiet(() => offOn("off", ["memory", "--project", w.project, "--home", w.home]));
    const claudeMd = readFileSync(path.join(w.home, ".claude", "CLAUDE.md"), "utf8");
    expect(claudeMd).toContain("# Global instructions");
    expect(claudeMd).not.toContain("agent-memory:start");
    expect(existsSync(path.join(w.home, ".claude", "skills", "agent-memory"))).toBe(false);
    expect(existsSync(path.join(w.home, ".claude", "skills", "example-skill"))).toBe(true);
    expect(Object.keys(json(".claude.json").mcpServers)).toEqual(["context7"]);
    expect(readFileSync(path.join(w.home, ".codex", "config.toml"), "utf8")).not.toContain("agent-memory");

    await quiet(() => offOn("on", ["--project", w.project, "--home", w.home]));
    expect(snapshot(w.home)).toEqual(before);
  });

  it("moves the installed skills it keeps current aside while off, and back on", async () => {
    w = await world();
    await run("--apply");
    const skill = path.join(w.home, ".claude", "skills", "vendor-skill");
    parentOf(path.join(skill, "SKILL.md"));
    writeFileSync(path.join(skill, "SKILL.md"), "---\nname: vendor-skill\ndescription: x\n---\n");
    writeFileSync(path.join(w.home, ".agent-cloud", "skills-state.json"), JSON.stringify({ skills: { "vendor-skill": { repo: "a/b", sha: "0", hash: "0" } } }));

    await quiet(() => offOn("off", ["all", "--project", w.project, "--home", w.home]));
    expect(existsSync(skill)).toBe(false);
    await quiet(() => offOn("on", ["--project", w.project, "--home", w.home]));
    expect(existsSync(path.join(skill, "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(w.home, ".agent-cloud", "off"))).toBe(false);
  });
});

describe("review fixes", () => {
  it("never claims another tool's `cli.js hook` session hook, even with --adopt", async () => {
    w = await world();
    const settingsFile = path.join(w.home, ".claude", "settings.json");
    parentOf(settingsFile);
    const theirs = { hooks: [{ type: "command", command: 'node "/opt/other-tool/dist/cli.js" hook' }] };
    writeFileSync(settingsFile, JSON.stringify({ hooks: { SessionStart: [theirs] } }));
    await run("--apply", "--adopt");
    const groups = json(".claude/settings.json").hooks.SessionStart;
    expect(groups).toContainEqual(theirs);
    expect(groups).toHaveLength(2);
    expect(await run("--apply")).not.toMatch(/^(create|update|adopt|unmanaged) +claude-code:hook/m);
  });

  it("off all finishes the job when run again after a run that stopped halfway", async () => {
    w = await world();
    await run("--apply");
    // A run that recorded "off" but removed nothing (it failed right after).
    writeFileSync(path.join(w.home, ".agent-cloud", "state.json"), JSON.stringify({ project: w.project, off: "all" }));
    await quiet(() => offOn("off", ["all", "--project", w.project, "--home", w.home]));
    expect(existsSync(path.join(w.home, ".claude", "CLAUDE.md"))).toBe(false);
  });

  it("one agent that can't take a server is skipped; the others are written and recorded", async () => {
    w = await world();
    const catalogFile = path.join(w.project, "config", "mcp", "catalog.json");
    const catalog = JSON.parse(readFileSync(catalogFile, "utf8"));
    catalog.servers.bad = { default: { type: "stdio", command: "tool", args: ["--key", "${env:AGENT_MEMORY_TOKEN}"] } };
    writeFileSync(catalogFile, JSON.stringify(catalog));
    const harnessesFile = path.join(w.project, "config", "harnesses.json");
    const harnesses = JSON.parse(readFileSync(harnessesFile, "utf8"));
    harnesses.harnesses["claude-desktop"].mcp.push("bad", "agent-memory");
    writeFileSync(harnessesFile, JSON.stringify(harnesses));
    const out = await run("--apply");
    expect(out).toMatch(/claude-desktop: skipped \(bad: the Claude app can't take a secret inside a command or args/);
    expect(existsSync(path.join(w.home, ".claude", "CLAUDE.md"))).toBe(true);
    expect(existsSync(path.join(w.home, ".agent-cloud", "managed.json"))).toBe(true);
  });

  it.skipIf(process.platform === "win32")("files holding secrets, and their backups, are readable by the user only", async () => {
    w = await world();
    const cursor = path.join(w.home, ".cursor", "mcp.json");
    parentOf(cursor);
    writeFileSync(cursor, "{}");
    await run("--apply", "--adopt");
    const { statSync, readdirSync } = await import("node:fs");
    for (const f of [".claude.json", ".codex/config.toml", ".cursor/mcp.json", ".gemini/config/mcp_config.json"]) expect(statSync(path.join(w.home, f)).mode & 0o077, f).toBe(0);
    const backup = readdirSync(path.dirname(cursor)).find((n) => n.startsWith("mcp.json.bak-"))!;
    expect(statSync(path.join(path.dirname(cursor), backup)).mode & 0o077).toBe(0);
  });
});

const parentOf = (file: string) => mkdirSync(path.dirname(file), { recursive: true });
