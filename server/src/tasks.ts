import {
  CLIENT_CAPABILITIES_META_KEY,
  type CallToolResult,
  type ClientCapabilities,
  type McpServer,
  ProtocolError,
  ProtocolErrorCode,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { waitUntil } from "cloudflare:workers";
import { z } from "zod";

/**
 * Tasks (MCP extension io.modelcontextprotocol/tasks, SEP-2663): a tool call can answer with a durable task handle
 * instead of its result, and the client polls tasks/get. Only clients that declare the extension on the request
 * get a task; everyone else gets the result inline, exactly as before.
 */

export const TASKS_EXTENSION_ID = "io.modelcontextprotocol/tasks";
/** Kept for two hours after creation (clients may resume a session and ask again later). */
export const TASK_TTL_MS = 2 * 3600 * 1000;
export const TASK_POLL_INTERVAL_MS = 2000;
/** Tool work here is short and bounded; a task silent for this long is not running any more. */
const STALE_MS = 2 * 60 * 1000;

export type TaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled";

export interface TaskRow {
  id: string;
  tool: string;
  status: TaskStatus;
  input: string;
  result: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  ttl_ms: number | null;
  poll_interval_ms: number | null;
}

const isExpired = (task: Pick<TaskRow, "created_at" | "ttl_ms">, now: Date) =>
  task.ttl_ms !== null && Date.parse(task.created_at) + task.ttl_ms <= now.getTime();

/** Deletes tasks past their time to live. */
export async function expireTasks(db: D1Database, now = new Date()): Promise<void> {
  await db
    .prepare("DELETE FROM tasks WHERE ttl_ms IS NOT NULL AND (julianday(?) - julianday(created_at)) * 86400000.0 >= ttl_ms")
    .bind(now.toISOString())
    .run();
}

export async function createTask(db: D1Database, tool: string, input: unknown, now = new Date()): Promise<TaskRow> {
  await expireTasks(db, now);
  const at = now.toISOString();
  const row = await db
    .prepare(
      `INSERT INTO tasks (id, tool, status, input, created_at, updated_at, ttl_ms, poll_interval_ms)
       VALUES (?, ?, 'working', ?, ?, ?, ?, ?) RETURNING *`,
    )
    .bind(crypto.randomUUID(), tool, JSON.stringify(input ?? {}), at, at, TASK_TTL_MS, TASK_POLL_INTERVAL_MS)
    .first<TaskRow>();
  return row!;
}

/**
 * The task, or null when unknown or expired. A task still "working" with no update for STALE_MS lost its run (the
 * runtime ended the waitUntil work), so it is reported failed instead of being polled until it expires.
 */
export async function getTask(db: D1Database, id: string, now = new Date()): Promise<TaskRow | null> {
  // Expired rows go on every read too, not only when a new task starts (results can contain note names).
  await expireTasks(db, now);
  const row = await db.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first<TaskRow>();
  if (!row || isExpired(row, now)) return null;
  if (row.status === "working" && now.getTime() - Date.parse(row.updated_at) > STALE_MS) {
    await finishTask(db, id, { status: "failed", error: "The work stopped before it finished. Run the tool again." });
    return db.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first<TaskRow>();
  }
  return row;
}

/** Records the outcome, unless the task already ended (e.g. cancelled): running the same work twice is harmless. */
export async function finishTask(
  db: D1Database,
  id: string,
  outcome: { status: "completed"; result: CallToolResult } | { status: "failed"; error: string },
): Promise<void> {
  await db
    .prepare("UPDATE tasks SET status = ?, result = ?, error = ?, updated_at = ? WHERE id = ? AND status IN ('working', 'input_required')")
    .bind(
      outcome.status,
      outcome.status === "completed" ? JSON.stringify(outcome.result) : null,
      outcome.status === "failed" ? outcome.error.slice(0, 1000) : null,
      new Date().toISOString(),
      id,
    )
    .run();
}

/** Marks a running task cancelled (cooperative: the work may still finish, but its result is dropped). */
export async function cancelTask(db: D1Database, id: string, now = new Date()): Promise<TaskRow | null> {
  await db
    .prepare("UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('working', 'input_required')")
    .bind(now.toISOString(), id)
    .run();
  return getTask(db, id, now);
}

/** The task as the extension's wire object (resultType is added by the caller or the SDK). */
export function taskView(task: TaskRow): Record<string, unknown> {
  const view: Record<string, unknown> = {
    taskId: task.id,
    status: task.status,
    createdAt: task.created_at,
    lastUpdatedAt: task.updated_at,
    ttlMs: task.ttl_ms,
    ...(task.poll_interval_ms !== null && { pollIntervalMs: task.poll_interval_ms }),
  };
  if (task.status === "completed" && task.result) view.result = JSON.parse(task.result) as unknown;
  if (task.status === "failed") view.error = { code: ProtocolErrorCode.InternalError, message: task.error ?? "Task failed" };
  if (task.status === "cancelled") view.statusMessage = "Cancelled.";
  return view;
}

/** Whether the client declared the tasks extension on this request (2026-07-28 per-request capabilities). */
export function clientAcceptsTasks(ctx: ServerContext): boolean {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const caps = envelope?.[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined;
  return caps?.extensions?.[TASKS_EXTENSION_ID] !== undefined;
}

/**
 * Runs a tool's work inline, or, when the client accepts tasks, as a task: the task row is stored before the
 * handle is returned, and the work continues after the response (ctx.waitUntil). `work` must be idempotent.
 */
export async function runAsTaskIfAccepted(
  db: D1Database,
  ctx: ServerContext,
  tool: string,
  input: unknown,
  work: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  if (!clientAcceptsTasks(ctx)) return work();
  const task = await createTask(db, tool, input);
  waitUntil(
    work().then(
      (result) => finishTask(db, task.id, { status: "completed", result }),
      (error: unknown) => finishTask(db, task.id, { status: "failed", error: error instanceof Error ? error.message : String(error) }),
    ),
  );
  // A CreateTaskResult: the SDK passes a non-"complete" resultType on tools/call through unchanged.
  return { resultType: "task", ...taskView(task) } as unknown as CallToolResult;
}

const unknownTask = () => new ProtocolError(ProtocolErrorCode.InvalidParams, "Unknown or expired task");

/** Serves tasks/get and tasks/cancel (explicit schemas, so the SDK serves them on every protocol era). */
export function registerTaskHandlers(server: McpServer, db: D1Database): void {
  server.server.registerCapabilities({ extensions: { [TASKS_EXTENSION_ID]: {} } });
  const params = z.object({ taskId: z.string().min(1).max(128) });
  server.server.setRequestHandler("tasks/get", { params }, async ({ taskId }) => {
    const task = await getTask(db, taskId);
    if (!task) throw unknownTask();
    return taskView(task);
  });
  server.server.setRequestHandler("tasks/cancel", { params }, async ({ taskId }) => {
    if (!(await cancelTask(db, taskId))) throw unknownTask();
    return {};
  });
}
