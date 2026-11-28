import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pointerMd } from "../server/src/memory-text.ts";
import { bundleSkills } from "../src/deploy.ts";
import { desktopConfigPath } from "../src/sync/desktop.ts";
import { type Catalog, localize, toClaudeDesktop, toCodex } from "../src/sync/mcp.ts";
import { writeWranglerConfig } from "../src/wrangler.ts";
import { quiet, world } from "./helpers.ts";

let w: Awaited<ReturnType<typeof world>> | undefined;
afterEach(() => w?.cleanup());

describe("localize", () => {
  const catalog: Catalog = {
    servers: {
      mem: { default: { type: "http", url: "${memoryUrl}/mcp", headers: { Authorization: "Bearer ${env:TOKEN}" } } },
      tool: { default: { type: "stdio", command: "${home}/bin/tool", args: ["--x"] }, codex: { type: "stdio", command: "${home}\\bin\\tool.exe" } },
    },
  };
  it("fills ${home} in each path's own slash style and ${memoryUrl}; keeps secrets as placeholders", () => {
    const out = localize(catalog, { home: "C:\\Users\\me", memoryUrl: "https://m.example", secrets: { TOKEN: "t" } }, () => true, () => {}, "win32");
    expect(out.servers.mem!.default).toEqual({ type: "http", url: "https://m.example/mcp", headers: { Authorization: "Bearer ${env:TOKEN}" } });
    expect((out.servers.tool!.default as { command: string }).command).toBe("C:/Users/me/bin/tool");
    expect((out.servers.tool!.codex as { command: string }).command).toBe("C:\\Users\\me\\bin\\tool.exe");
  });
  it("leaves out a server with a missing program or an unset secret, per harness", () => {
    const warnings: string[] = [];
    const out = localize(catalog, { home: "/home/me", memoryUrl: "https://m", secrets: {} }, (p) => !p.endsWith("tool"), (m) => warnings.push(m), "linux");
    expect(out.servers.mem!.default).toBeUndefined();
    expect(out.servers.tool!.default).toBeUndefined();
    expect(warnings.join("\n")).toMatch(/mem: left out, secret\(s\) not set on this PC: TOKEN/);
    expect(warnings.join("\n")).toMatch(/tool: not installed on this PC/);
  });
});

describe("format converters", () => {
  it("Claude app: a remote server goes through mcp-remote with the secret in env, never on the command line", () => {
    const def = { type: "http" as const, url: "https://x/mcp", headers: { "X-Key": "${env:KEY}" } };
    const win = toClaudeDesktop("x", def, { KEY: "secret" }, "win32");
    expect(win).toEqual({ command: "cmd", args: ["/c", "npx", "-y", "mcp-remote@latest", "https://x/mcp", "--header", "X-Key:${KEY}"], env: { KEY: "secret" } });
    expect(toClaudeDesktop("x", def, { KEY: "secret" }, "darwin").command).toBe("npx");
    expect(JSON.stringify(win.args)).not.toContain("secret");
  });
  it("Claude app: a header with a secret inside other text goes whole into one variable", () => {
    const out = toClaudeDesktop("m", { type: "http", url: "https://m/mcp", headers: { Authorization: "Bearer ${env:T}" } }, { T: "tok" }, "darwin");
    expect(out.args).toContain("Authorization:${AGENT_CLOUD_HEADER_AUTHORIZATION}");
    expect(out.env).toEqual({ AGENT_CLOUD_HEADER_AUTHORIZATION: "Bearer tok" });
  });
  it("Codex: secrets filled into env and http_headers", () => {
    expect(toCodex({ type: "http", url: "https://x", headers: { Authorization: "Bearer ${env:T}" } }, { T: "v" })).toEqual({ url: "https://x", http_headers: { Authorization: "Bearer v" } });
    expect(toCodex({ type: "stdio", command: "c", env: { K: "${env:K}" } }, { K: "v" })).toEqual({ command: "c", env: { K: "v" } });
  });
});

describe("paths and text", () => {
  it("finds the Claude app's config per OS", () => {
    expect(desktopConfigPath("/Users/me", "darwin")).toBe(path.join("/Users/me", "Library", "Application Support", "Claude", "claude_desktop_config.json"));
    expect(desktopConfigPath("/home/me", "linux")).toBe(path.join("/home/me", ".config", "Claude", "claude_desktop_config.json"));
  });
  it("the memory section names only the given server", () => {
    const md = pointerMd({ url: "https://m.example/" });
    expect(md).toContain("`https://m.example/mcp`");
    expect(md).toMatch(/^<!-- agent-memory:start -->[\s\S]*<!-- agent-memory:end -->$/);
  });
});

describe("deploy pieces", () => {
  it("writes a Worker config from the settings: workers.dev without a domain, the domain route with one", async () => {
    w = await world();
    const settings = JSON.parse(readFileSync(path.join(w.project, "agent-cloud.json"), "utf8"));
    const jsonc = (f: string) => JSON.parse(readFileSync(f, "utf8").replace(/^\/\/.*\n/, ""));
    const file = writeWranglerConfig(w.project, settings);
    const config = jsonc(file);
    expect(config.workers_dev).toBe(true);
    expect(config.routes).toBeUndefined();
    expect(config.vars.PUBLIC_URL).toBe("https://memory.example.com");
    expect(config.assets).toEqual({ directory: "assets", binding: "SKILLS", run_worker_first: true });
    expect(existsSync(path.resolve(path.dirname(file), config.main))).toBe(true);
    expect(existsSync(path.resolve(path.dirname(file), config.d1_databases[0].migrations_dir, "0001_init.sql"))).toBe(true);

    const custom = jsonc(writeWranglerConfig(w.project, { ...settings, memory: { ...settings.memory, domain: "memory.example.com" } }));
    expect(custom.workers_dev).toBe(false);
    expect(custom.routes).toEqual([{ pattern: "memory.example.com", custom_domain: true }]);

    // The bin: 14 days and a daily run by default; binDays 0 = no run; a bad value is refused.
    expect(config.vars.BIN_DAYS).toBe("14");
    expect(config.triggers.crons).toHaveLength(1);
    const never = jsonc(writeWranglerConfig(w.project, { ...settings, memory: { ...settings.memory, binDays: 0 } }));
    expect(never.vars.BIN_DAYS).toBe("0");
    expect(never.triggers.crons).toEqual([]);
    expect(() => writeWranglerConfig(w!.project, { ...settings, memory: { ...settings.memory, binDays: -1 } })).toThrow(/binDays/);
  });

  it("bundles config/skills and the global rules into the private skills file", async () => {
    w = await world();
    const out = await quiet(() => bundleSkills(w!.project));
    expect(out).toContain("agent-memory, example-skill, global-rules");
    const files = JSON.parse(readFileSync(path.join(w.project, ".agent-cloud", "assets", "skills.json"), "utf8")).files;
    expect(Object.keys(files).sort()).toEqual(["example-skill/SKILL.md", "global-rules/SKILL.md"]);
  });
});
