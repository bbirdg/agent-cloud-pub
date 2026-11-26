import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { BASE, addDevice, rpc } from "./helpers";

const GOOD = "amem_good-token-0123456789abcdefghijklmnop";

describe("auth on /mcp", () => {
  it("rejects requests without a token, with a wrong token, or a revoked one", async () => {
    await addDevice("revoked-pc", "amem_revoked-0123456789abcdefghijklmnop", { revoked: true });
    const none = await rpc(null, "tools/list");
    expect(none.status).toBe(401);
    expect(none.headers.get("WWW-Authenticate")).toContain("resource_metadata");
    expect((await rpc("amem_wrong-0123456789abcdefghijklmnopqrs", "tools/list")).status).toBe(401);
    expect((await rpc("amem_revoked-0123456789abcdefghijklmnop", "tools/list")).status).toBe(401);
    expect((await rpc("not-a-device-token", "tools/list")).status).toBe(401);
  });

  it("serves the memory tools to a valid device token and records the device as the actor", async () => {
    await addDevice("codex-pc", GOOD);
    const list = await rpc(GOOD, "tools/list");
    expect(list.status).toBe(200);
    const names = list.json.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual([
      "memory_browse",
      "memory_context",
      "memory_maintenance",
      "memory_projects",
      "memory_purge",
      "memory_read",
      "memory_save",
      "memory_search",
      "memory_set_status",
    ]);

    const saved = await rpc(GOOD, "tools/call", {
      name: "memory_save",
      arguments: { project: "_global", name: "Reply style", description: "Short answers", type: "user", body: "Keep answers short." },
    });
    expect(saved.json.result.content[0].text).toContain("Saved _global/reply-style");
    const row = await env.DB.prepare("SELECT updated_by FROM notes WHERE id = 'reply-style'").first<{ updated_by: string }>();
    expect(row?.updated_by).toBe("codex-pc");

    const refused = await rpc(GOOD, "tools/call", {
      name: "memory_save",
      arguments: { project: "_global", name: "Key", description: "x", type: "reference", body: "sk-ant-abcdefghijklmnopqrstuvwxyz" },
    });
    expect(refused.json.result.isError).toBe(true);
  });

  it("publishes protected resource metadata pointing at this server", async () => {
    const response = await exports.default.fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`);
    expect(response.status).toBe(200);
    const meta = (await response.json()) as { resource: string; authorization_servers: string[] };
    expect(meta.resource).toBe(`${BASE}/mcp`);
    expect(meta.authorization_servers).toEqual([BASE]);
  });
});

describe("/context for the session hook", () => {
  it("needs a device token and returns the plain-text index", async () => {
    expect((await exports.default.fetch(`${BASE}/context`)).status).toBe(401);
    await addDevice("hook-pc", GOOD);
    const response = await exports.default.fetch(`${BASE}/context?cwd=C:/somewhere`, { headers: { Authorization: `Bearer ${GOOD}` } });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("# Agent memory — global");
    expect(text).toContain("No backup of this memory has completed yet");
  });
});

describe("health", () => {
  it("answers without auth and reveals nothing", async () => {
    const response = await exports.default.fetch(`${BASE}/health`);
    expect(await response.text()).toBe("ok");
  });
});
