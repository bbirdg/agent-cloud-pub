import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { BROWSER_URI, claudeAppDomain } from "../src/browser";
import { BASE, TOKEN, addDevice, modernClient, rpc } from "./helpers";

const MIME = "text/html;profile=mcp-app";

beforeEach(async () => {
  await addDevice("apps-pc", TOKEN);
});

describe("memory browser MCP App", () => {
  it("computes Claude's ui.domain the documented way", async () => {
    expect(await claudeAppDomain("https://example.com/mcp")).toBe("c3d80a4ed901ee05b21755a88273b4a4.claudemcpcontent.com");
  });

  it("lists and serves the UI resource with the MCP Apps mime type and this server's domain", async () => {
    const domain = await claudeAppDomain(`${BASE}/mcp`);
    const list = await rpc(TOKEN, "resources/list");
    const resource = list.json.result.resources.find((r: { uri: string }) => r.uri === BROWSER_URI);
    expect(resource).toMatchObject({ mimeType: MIME, _meta: { ui: { domain } } });

    const read = await rpc(TOKEN, "resources/read", { uri: BROWSER_URI });
    const content = read.json.result.contents[0];
    expect(content).toMatchObject({ uri: BROWSER_URI, mimeType: MIME, _meta: { ui: { domain } } });
    // Self-contained: no external scripts, styles or fetches.
    expect(content.text).toContain("<!doctype html>");
    expect(content.text).not.toMatch(/<script[^>]+src=|<link[^>]+href=|fetch\(|https?:\/\//);
  });

  it("links memory_browse to the UI and returns a text fallback plus structured data", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO notes (project, id, name, description, type, body) VALUES ('_global', 'style', 'Reply style', 'Short answers', 'user', 'Keep it short.')"),
      env.DB.prepare("INSERT INTO notes (project, id, name, description, type, body, status) VALUES ('_global', 'gone', 'Gone note', 'Old', 'user', 'x', 'deleted')"),
    ]);
    const client = await modernClient(TOKEN);
    const { tools } = await client.listTools();
    const browse = tools.find((t) => t.name === "memory_browse");
    expect(browse?._meta).toMatchObject({ ui: { resourceUri: BROWSER_URI }, "ui/resourceUri": BROWSER_URI });

    const all = await client.callTool({ name: "memory_browse", arguments: {} });
    const text = (all.content[0] as { text: string }).text;
    expect(text).toContain("[Reply style](_global/style)");
    expect(text).toContain("[Gone note](_global/gone) — Old (deleted)");
    expect(text).toContain("No backup of this memory has completed yet");
    const data = all.structuredContent as { notes: { id: string }[]; projects: { key: string }[]; backup: { warning: string } };
    expect(data.notes.map((n) => n.id).sort()).toEqual(["gone", "style"]);
    expect(data.projects.map((p) => p.key)).toContain("_global");

    const searched = await client.callTool({ name: "memory_browse", arguments: { query: "short", status: "active" } });
    expect((searched.structuredContent as { notes: { id: string }[] }).notes.map((n) => n.id)).toEqual(["style"]);
    await client.close();
  });

  it("marks memory_context to load upfront in Claude Code", async () => {
    const list = await rpc(TOKEN, "tools/list");
    const context = list.json.result.tools.find((t: { name: string }) => t.name === "memory_context");
    expect(context._meta).toEqual({ "anthropic/alwaysLoad": true });
  });
});
