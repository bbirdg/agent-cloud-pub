import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { TOKEN, addDevice, modernClient, modernRpc, rpc } from "./helpers";

const TASKS = { extensions: { "io.modelcontextprotocol/tasks": {} } };

async function seedDuplicates() {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO notes (project, id, name, description, type, body) VALUES ('_global', 'style', 'Reply style', 'd', 'user', 'Short.')"),
    env.DB.prepare("INSERT INTO notes (project, id, name, description, type, body) VALUES ('_global', 'style-2', ' reply STYLE ', 'd', 'user', 'Brief.')"),
    env.DB.prepare("INSERT INTO notes (project, id, name, description, type, body, status) VALUES ('_global', 'style-3', 'Reply style', 'd', 'user', 'Old.', 'deleted')"),
    env.DB.prepare("INSERT INTO meta (key, value) VALUES ('last_backup_at', ?)").bind(new Date().toISOString()),
  ]);
}

/** Polls tasks/get until the task leaves "working" (the work runs after the response, in waitUntil). */
async function settle(taskId: string) {
  for (let i = 0; i < 50; i++) {
    const got = await modernRpc(TOKEN, "tasks/get", { taskId }, { capabilities: TASKS });
    if (got.json.result?.status !== "working") return got.json;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("task never finished");
}

beforeEach(async () => {
  await addDevice("tasks-pc", TOKEN);
});

describe("memory_maintenance", () => {
  it("runs inline and returns its report when the client did not declare tasks", async () => {
    await seedDuplicates();
    const client = await modernClient(TOKEN);
    const result = await client.callTool({ name: "memory_maintenance", arguments: {} });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Search index rebuilt (3 notes)");
    expect(text).toContain("Backup OK");
    expect(text).toContain("_global/style, _global/style-2");
    expect(text).not.toContain("style-3");
    expect((await rpc(TOKEN, "tools/call", { name: "memory_maintenance", arguments: {} })).json.result.content[0].text).toContain("rebuilt");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM tasks").first<{ n: number }>())!.n).toBe(0);
    await client.close();
  });

  it("answers with a task when the client declared the extension, then completes it", async () => {
    await seedDuplicates();
    const created = await modernRpc(TOKEN, "tools/call", { name: "memory_maintenance", arguments: {} }, { capabilities: TASKS });
    const task = created.json.result;
    expect(task).toMatchObject({ resultType: "task", status: "working", ttlMs: 7_200_000, pollIntervalMs: 2000 });
    expect(task.taskId).toMatch(/^[\x21-\x7e]{1,128}$/);
    expect(task.createdAt).toBe(task.lastUpdatedAt);

    const done = await settle(task.taskId);
    expect(done.result).toMatchObject({ resultType: "complete", taskId: task.taskId, status: "completed" });
    expect(done.result.result.content[0].text).toContain("Search index rebuilt (3 notes)");
  });

  it("advertises the tasks extension", async () => {
    const discover = await modernRpc(TOKEN, "server/discover");
    expect(discover.json.result.capabilities.extensions).toHaveProperty(["io.modelcontextprotocol/tasks"]);
  });
});

describe("tasks/get and tasks/cancel", () => {
  async function insertTask(id: string, createdAt: string, status = "working") {
    await env.DB.prepare("INSERT INTO tasks (id, tool, status, created_at, updated_at, ttl_ms, poll_interval_ms) VALUES (?, 'memory_maintenance', ?, ?, ?, 3600000, 2000)")
      .bind(id, status, createdAt, createdAt)
      .run();
  }

  it("cancels a running task and keeps it cancelled", async () => {
    await insertTask("t-run", new Date().toISOString());
    const cancel = await modernRpc(TOKEN, "tasks/cancel", { taskId: "t-run" }, { capabilities: TASKS });
    expect(cancel.json.result).toMatchObject({ resultType: "complete" });
    const got = await modernRpc(TOKEN, "tasks/get", { taskId: "t-run" }, { capabilities: TASKS });
    expect(got.json.result.status).toBe("cancelled");
    // A late finish does not overwrite the cancellation.
    const { finishTask } = await import("../src/tasks");
    await finishTask(env.DB, "t-run", { status: "completed", result: { content: [] } });
    expect((await modernRpc(TOKEN, "tasks/get", { taskId: "t-run" }, { capabilities: TASKS })).json.result.status).toBe("cancelled");
  });

  it("reports a task whose run was lost as failed instead of working forever", async () => {
    await insertTask("t-lost", new Date(Date.now() - 5 * 60 * 1000).toISOString());
    const got = await modernRpc(TOKEN, "tasks/get", { taskId: "t-lost" }, { capabilities: TASKS });
    expect(got.json.result).toMatchObject({ status: "failed", error: { code: -32603, message: expect.stringContaining("Run the tool again") } });
  });

  it("does not return an expired task", async () => {
    await insertTask("t-old", "2026-01-01T00:00:00.000Z", "completed");
    const got = await modernRpc(TOKEN, "tasks/get", { taskId: "t-old" }, { capabilities: TASKS });
    expect(got.json.error?.code).toBe(-32602);
  });

  it("answers -32602 for an unknown task id", async () => {
    expect((await modernRpc(TOKEN, "tasks/get", { taskId: "nope" }, { capabilities: TASKS })).json.error?.code).toBe(-32602);
    expect((await modernRpc(TOKEN, "tasks/cancel", { taskId: "nope" }, { capabilities: TASKS })).json.error?.code).toBe(-32602);
  });

  it("is closed to backup-scoped device tokens, like every MCP route", async () => {
    const backupToken = "amem_backup-0123456789abcdefghijklmnopq";
    await addDevice("github-backup", backupToken, { scope: "backup" });
    await insertTask("t-run", new Date().toISOString());
    expect((await modernRpc(backupToken, "tasks/get", { taskId: "t-run" })).status).toBe(401);
    expect((await rpc(backupToken, "tools/call", { name: "memory_maintenance", arguments: {} })).status).toBe(401);
    expect((await rpc(backupToken, "tools/call", { name: "memory_purge", arguments: { id: "_global/x", confirm: true } })).status).toBe(401);
    expect((await rpc(backupToken, "resources/read", { uri: "ui://memory/browser" })).status).toBe(401);
  });
});
