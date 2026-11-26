import { Client, type ElicitResult, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { env, exports } from "cloudflare:workers";
import { sha256Hex } from "../src/auth";

export const BASE = "http://localhost:8787";
export const TOKEN = "amem_test-token-0123456789abcdefghijklmnop";

export async function addDevice(name: string, token: string, opts: { revoked?: boolean; scope?: "full" | "backup" } = {}) {
  await env.DB.prepare("INSERT INTO devices (id, name, token_hash, revoked_at, scope) VALUES (?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), name, await sha256Hex(token), opts.revoked ? new Date().toISOString() : null, opts.scope ?? "full")
    .run();
}

/** Sends one JSON-RPC request the way a stateless 2025-06-18 client does, and returns the parsed body. */
export async function rpc(token: string | null, method: string, params: Record<string, unknown> = {}) {
  const response = await exports.default.fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
      Host: "localhost:8787", // real clients always send it; the MCP handler checks it
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const raw = await response.text();
  const json = response.headers.get("Content-Type")?.includes("text/event-stream")
    ? raw.split("\n").filter((l: string) => l.startsWith("data:")).map((l: string) => JSON.parse(l.slice(5)))[0]
    : raw
      ? JSON.parse(raw)
      : null;
  return { status: response.status, json, headers: response.headers };
}

/**
 * One raw 2026-07-28 JSON-RPC request (per-request `_meta` envelope plus the standard headers), for wire shapes the
 * SDK client does not expose: task handles, tampered requestState. `extra` goes at the top level of params.
 */
export async function modernRpc(
  token: string,
  method: string,
  params: Record<string, unknown> = {},
  opts: { capabilities?: Record<string, unknown>; extra?: Record<string, unknown> } = {},
) {
  const name = method === "tools/call" ? params.name : method === "resources/read" ? params.uri : method.startsWith("tasks/") ? params.taskId : undefined;
  const response = await exports.default.fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": method,
      ...(typeof name === "string" ? { "Mcp-Name": name } : {}),
      Host: "localhost:8787",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        ...opts.extra,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "vitest-raw", version: "1.0.0" },
          "io.modelcontextprotocol/clientCapabilities": opts.capabilities ?? {},
        },
      },
    }),
  });
  const raw = await response.text();
  const json = response.headers.get("Content-Type")?.includes("text/event-stream")
    ? raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5))).at(-1)
    : raw
      ? JSON.parse(raw)
      : null;
  return { status: response.status, json };
}

/** Routes the SDK client's HTTP calls into this Worker in-process, with the device token and Host header. */
export function workerFetch(token: string) {
  return (url: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("Host", "localhost:8787");
    return exports.default.fetch(new Request(url, { ...init, headers }));
  };
}

/** An MCP v2 client speaking the 2026-07-28 revision (no fallback), connected to the Worker under test. */
export async function modernClient(token: string, opts: { onElicit?: (message: string) => ElicitResult } = {}): Promise<Client> {
  const client = new Client(
    { name: "vitest", version: "1.0.0" },
    { capabilities: opts.onElicit ? { elicitation: { form: {} } } : {}, versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  if (opts.onElicit) {
    const answer = opts.onElicit;
    client.setRequestHandler("elicitation/create", async (request) => answer(request.params.message));
  }
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { fetch: workerFetch(token) }));
  return client;
}
