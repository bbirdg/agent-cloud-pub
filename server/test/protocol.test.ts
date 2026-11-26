import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { TOKEN, addDevice, modernClient, rpc } from "./helpers";

async function seedNote() {
  await env.DB.prepare(
    "INSERT INTO notes (project, id, name, description, type, body) VALUES ('_global', 'reply-style', 'Reply style', 'Short answers', 'user', 'Keep answers short.')",
  ).run();
}

describe("protocol revision 2026-07-28 (modern lane)", () => {
  it("connects with the v2 client, lists tools and calls memory_search", async () => {
    await addDevice("modern-pc", TOKEN);
    await seedNote();
    const client = await modernClient(TOKEN);
    expect(client.getProtocolEra()).toBe("modern");

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("memory_search");

    const result = await client.callTool({ name: "memory_search", arguments: { query: "reply" } });
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect((result.content[0] as { text: string }).text).toContain("_global/reply-style");
    await client.close();
  });

  it("refuses the modern lane without a valid token", async () => {
    await expect(modernClient("amem_wrong-0123456789abcdefghijklmnopqrs")).rejects.toThrow();
  });
});

describe("protocol revision 2025-06-18 (legacy stateless lane)", () => {
  it("lists tools and calls memory_search", async () => {
    await addDevice("legacy-pc", TOKEN);
    await seedNote();
    const list = await rpc(TOKEN, "tools/list");
    expect(list.status).toBe(200);
    expect(list.json.result.tools.map((t: { name: string }) => t.name)).toContain("memory_search");
    const call = await rpc(TOKEN, "tools/call", { name: "memory_search", arguments: { query: "reply" } });
    expect(call.json.result.content[0].text).toContain("_global/reply-style");
  });
});
