import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { stateCodec } from "../src/elicit";
import { TOKEN, addDevice, modernClient, modernRpc, rpc } from "./helpers";

const ELICIT = { elicitation: { form: {} } };

/** A note in the bin (or active), deleted `hoursAgo` hours ago. */
async function seed(status: "active" | "deleted" = "deleted", hoursAgo = 48) {
  const at = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO notes (project, id, name, description, type, body, status, version, updated_at) VALUES ('_global', 'old-key', 'Old key place', 'Where a key was', 'reference', 'secret-ish text', ?, 2, ?)",
    ).bind(status, at),
    env.DB.prepare(
      "INSERT INTO note_versions (project, id, version, name, description, type, body, status, saved_at, saved_by) VALUES ('_global', 'old-key', 1, 'Old key place', 'Where a key was', 'reference', 'older text', 'active', '2026-01-01', 'pc')",
    ),
    env.DB.prepare("INSERT INTO audit (actor, action, project, note_id, detail) VALUES ('pc', 'create', '_global', 'old-key', 'Old key place')"),
  ]);
}

async function counts() {
  const notes = await env.DB.prepare("SELECT COUNT(*) AS n FROM notes WHERE id = 'old-key'").first<{ n: number }>();
  const versions = await env.DB.prepare("SELECT COUNT(*) AS n FROM note_versions WHERE id = 'old-key'").first<{ n: number }>();
  return { notes: notes!.n, versions: versions!.n };
}

const textOf = (result: { content: unknown[] }) => (result.content[0] as { text: string }).text;

beforeEach(async () => {
  await addDevice("purge-pc", TOKEN);
});

describe("memory_purge with elicitation (2026-07-28)", () => {
  it("erases the note, its versions and its audit text when the user accepts", async () => {
    await seed();
    const asked: string[] = [];
    const client = await modernClient(TOKEN, { onElicit: (m) => (asked.push(m), { action: "accept", content: { confirm: true } }) });
    const result = await client.callTool({ name: "memory_purge", arguments: { id: "_global/old-key" } });
    expect(textOf(result)).toContain("Erased _global/old-key");
    expect(asked[0]).toContain("Old key place");
    expect(await counts()).toEqual({ notes: 0, versions: 0 });
    const audit = await env.DB.prepare("SELECT action, detail FROM audit WHERE note_id = 'old-key' ORDER BY seq").all<{ action: string; detail: string | null }>();
    expect(audit.results).toEqual([
      { action: "create", detail: null },
      { action: "purge", detail: null },
    ]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM notes_fts WHERE notes_fts MATCH 'older OR secret'").first<{ n: number }>())!.n).toBe(0);
    await client.close();
  });

  it("keeps the note when the user declines, cancels or answers no", async () => {
    await seed();
    for (const answer of [{ action: "decline" }, { action: "cancel" }, { action: "accept", content: { confirm: false } }] as const) {
      const client = await modernClient(TOKEN, { onElicit: () => answer });
      const result = await client.callTool({ name: "memory_purge", arguments: { id: "_global/old-key" } });
      expect(textOf(result)).toMatch(/Cancelled/);
      await client.close();
    }
    expect(await counts()).toEqual({ notes: 1, versions: 1 });
  });

  it("ignores confirm=true from the model when the client can ask the user", async () => {
    await seed();
    const first = await modernRpc(TOKEN, "tools/call", { name: "memory_purge", arguments: { id: "_global/old-key", confirm: true } }, { capabilities: ELICIT });
    expect(first.json.result.resultType).toBe("input_required");
    expect(await counts()).toEqual({ notes: 1, versions: 1 });
  });

  it("rejects a tampered or foreign requestState", async () => {
    await seed();
    const first = await modernRpc(TOKEN, "tools/call", { name: "memory_purge", arguments: { id: "_global/old-key" } }, { capabilities: ELICIT });
    const state: string = first.json.result.requestState;
    expect(state).toMatch(/^v1\./);
    const accept = { inputResponses: { confirm: { action: "accept", content: { confirm: true } } } };

    const [head, body, mac] = state.split(".");
    const forged = JSON.parse(atob(body!.replace(/-/g, "+").replace(/_/g, "/")));
    forged.p.subject = "_global/other@1";
    const tampered = `${head}.${btoa(JSON.stringify(forged)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}.${mac}`;
    for (const requestState of [tampered, "garbage"]) {
      const retry = await modernRpc(TOKEN, "tools/call", { name: "memory_purge", arguments: { id: "_global/old-key" } }, {
        capabilities: ELICIT,
        extra: { ...accept, requestState },
      });
      expect(retry.json.error?.code).toBe(-32602);
    }

    // Valid state, but minted for another device: the caller binding refuses it.
    await addDevice("other-pc", "amem_other-0123456789abcdefghijklmnopqr");
    const foreign = await modernRpc("amem_other-0123456789abcdefghijklmnopqr", "tools/call", { name: "memory_purge", arguments: { id: "_global/old-key" } }, {
      capabilities: ELICIT,
      extra: { ...accept, requestState: state },
    });
    expect(foreign.json.error?.code).toBe(-32602);
    expect(await counts()).toEqual({ notes: 1, versions: 1 });

    // The untampered state still works for the device it was minted for.
    const ok = await modernRpc(TOKEN, "tools/call", { name: "memory_purge", arguments: { id: "_global/old-key" } }, {
      capabilities: ELICIT,
      extra: { ...accept, requestState: state },
    });
    expect(ok.json.result.content[0].text).toContain("Erased");
  });

  it("refuses a confirmation given for an older version of the note", async () => {
    await seed();
    const first = await modernRpc(TOKEN, "tools/call", { name: "memory_purge", arguments: { id: "_global/old-key" } }, { capabilities: ELICIT });
    // Restored and deleted again in between: same note, new version.
    await env.DB.prepare("UPDATE notes SET version = 4 WHERE id = 'old-key'").run();
    const retry = await modernRpc(TOKEN, "tools/call", { name: "memory_purge", arguments: { id: "_global/old-key" } }, {
      capabilities: ELICIT,
      extra: { inputResponses: { confirm: { action: "accept", content: { confirm: true } } }, requestState: first.json.result.requestState },
    });
    expect(retry.json.result.isError).toBe(true);
    expect(await counts()).toEqual({ notes: 1, versions: 1 });
  });

  it("can't replay an old confirmation on a later note with the same id and version", async () => {
    await seed();
    const first = await modernRpc(TOKEN, "tools/call", { name: "memory_purge", arguments: { id: "_global/old-key" } }, { capabilities: ELICIT });
    const accepted = { inputResponses: { confirm: { action: "accept", content: { confirm: true } } }, requestState: first.json.result.requestState };
    const done = await modernRpc(TOKEN, "tools/call", { name: "memory_purge", arguments: { id: "_global/old-key" } }, { capabilities: ELICIT, extra: accepted });
    expect(done.json.result.content[0].text).toContain("Erased");
    // Re-created under the same id, deleted again: same version number, new row.
    await seed();
    const replay = await modernRpc(TOKEN, "tools/call", { name: "memory_purge", arguments: { id: "_global/old-key" } }, { capabilities: ELICIT, extra: accepted });
    expect(replay.json.result.isError).toBe(true);
    expect(await counts()).toEqual({ notes: 1, versions: 1 });
  });

  it("is hidden from MCP App views; only the model can call it", async () => {
    const list = await rpc(TOKEN, "tools/list");
    const purge = list.json.result.tools.find((t: { name: string }) => t.name === "memory_purge");
    const save = list.json.result.tools.find((t: { name: string }) => t.name === "memory_save");
    expect(purge._meta.ui.visibility).toEqual(["model"]);
    expect(save._meta.ui.visibility).toEqual(["model"]);
  });

  it("refuses notes that are not in the bin, and unknown notes", async () => {
    await seed("active");
    const client = await modernClient(TOKEN, { onElicit: () => ({ action: "accept", content: { confirm: true } }) });
    const active = await client.callTool({ name: "memory_purge", arguments: { id: "_global/old-key" } });
    expect(active.isError).toBe(true);
    expect(textOf(active)).toContain("not in the bin");
    const missing = await client.callTool({ name: "memory_purge", arguments: { id: "_global/nope" } });
    expect(missing.isError).toBe(true);
    expect(await counts()).toEqual({ notes: 1, versions: 1 });
    await client.close();
  });
});

describe("memory_purge fallback (no elicitation)", () => {
  it("asks for confirmation in chat on the legacy lane, then erases with confirm=true", async () => {
    await seed();
    const first = await rpc(TOKEN, "tools/call", { name: "memory_purge", arguments: { id: "_global/old-key" } });
    expect(first.json.result.isError).toBeFalsy();
    expect(first.json.result.content[0].text).toContain("confirm=true");
    expect(await counts()).toEqual({ notes: 1, versions: 1 });
    const second = await rpc(TOKEN, "tools/call", { name: "memory_purge", arguments: { id: "_global/old-key", confirm: true } });
    expect(second.json.result.content[0].text).toContain("Erased");
    expect(await counts()).toEqual({ notes: 0, versions: 0 });
  });

  it("refuses a note deleted less than 24 hours ago, even with confirm=true (delete-then-purge can't skip the user)", async () => {
    await seed("deleted", 1);
    const call = await rpc(TOKEN, "tools/call", { name: "memory_purge", arguments: { id: "_global/old-key", confirm: true } });
    expect(call.json.result.content[0].text).toContain("24 hours");
    expect(await counts()).toEqual({ notes: 1, versions: 1 });
  });

  it("uses the same fallback for a modern client that declared no elicitation", async () => {
    await seed();
    const client = await modernClient(TOKEN);
    const result = await client.callTool({ name: "memory_purge", arguments: { id: "_global/old-key" } });
    expect(textOf(result)).toContain("confirm=true");
    expect(await counts()).toEqual({ notes: 1, versions: 1 });
    await client.close();
  });
});

describe("MCP_STATE_SECRET", () => {
  it("is required to be at least 32 bytes", () => {
    expect(stateCodec(undefined)).toBeNull();
    expect(stateCodec("too-short")).toBeNull();
    expect(stateCodec("x".repeat(32))).not.toBeNull();
  });

  it("when missing, turns memory_purge off and leaves every other tool working", async () => {
    await seed();
    const bindings = env as unknown as { MCP_STATE_SECRET?: string };
    const secret = bindings.MCP_STATE_SECRET;
    bindings.MCP_STATE_SECRET = undefined;
    try {
      const purge = await rpc(TOKEN, "tools/call", { name: "memory_purge", arguments: { id: "_global/old-key", confirm: true } });
      expect(purge.json.result.isError).toBe(true);
      expect(purge.json.result.content[0].text).toContain("MCP_STATE_SECRET");
      const search = await rpc(TOKEN, "tools/call", { name: "memory_projects", arguments: {} });
      expect(search.json.result.content[0].text).toContain("_global");
    } finally {
      bindings.MCP_STATE_SECRET = secret;
    }
    expect(await counts()).toEqual({ notes: 1, versions: 1 });
  });
});
