import "./env";
import { OAuthResourceServer, insufficientScope } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { env } from "cloudflare:workers";
import type { Actor, Env } from "./env";
import {
  DEVICE_TOKEN_PREFIX,
  type DeviceScope,
  SCOPES,
  authorizationServer,
  bearerToken,
  handleAuthorize,
  handleCallback,
  mcpResourceUrl,
  validateDeviceToken,
} from "./auth";
import { exportIndexes, exportPage, exportProjects, recordBackup } from "./export";
import { finishSetup, setupPage, startSetup } from "./github-app";
import { createServer } from "./mcp";
import { buildContext } from "./memory";

const mcpHandler = createMcpHandler(createServer, { route: "/mcp" });

/** /mcp accepts GitHub-login OAuth tokens (claude.ai) and device tokens (CLI agents). */
const mcpResource = new OAuthResourceServer<Env, Actor>({
  resourceMetadata: {
    resource: mcpResourceUrl(),
    authorization_servers: [env.PUBLIC_URL],
    resource_name: "Agent memory",
  },
  requiredScopes: ["memory"],
  validateToken: (env) => async (resource, token) => {
    // Device tokens are recognized by shape and never sent to the authorization server.
    if (token.startsWith(DEVICE_TOKEN_PREFIX)) {
      const actor = await validateDeviceToken(env.DB, token);
      return actor ? { props: actor, audience: resource, scope: SCOPES, userId: actor.name } : null;
    }
    return authorizationServer.validateToken(resource, token, env);
  },
  handler: {
    fetch(request, env, ctx) {
      if (!ctx.auth.scope.includes("memory")) return insufficientScope(ctx.auth, ["memory"]);
      return mcpHandler(request, env, ctx);
    },
  },
});

async function isDevice(request: Request, env: Env, allowed: DeviceScope[] = ["full"]): Promise<Actor | null> {
  const token = bearerToken(request);
  return token ? validateDeviceToken(env.DB, token, allowed) : null;
}

const unauthorized = () =>new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": "Bearer" } });

async function handleContext(request: Request, env: Env): Promise<Response> {
  if (!(await isDevice(request, env))) return unauthorized();
  const params = new URL(request.url).searchParams;
  const body = await buildContext(env.DB, {
    project: params.get("project") ?? undefined,
    cwd: params.get("cwd") ?? undefined,
    gitRemote: params.get("remote") ?? undefined,
  });
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

/** Backup export for the GitHub Action: backup-scoped or full device tokens. */
async function handleExport(request: Request, env: Env, pathname: string): Promise<Response> {
  const device = await isDevice(request, env, ["full", "backup"]);
  if (!device) return unauthorized();
  const params = new URL(request.url).searchParams;
  if (pathname === "/export" && request.method === "GET") {
    return Response.json(await exportPage(env.DB, Number(params.get("after") ?? 0) || 0, Number(params.get("limit") ?? 100) || 100));
  }
  if (pathname === "/export/indexes" && request.method === "GET") {
    return Response.json({ files: [...(await exportIndexes(env.DB)), await exportProjects(env.DB)] });
  }
  if (pathname === "/export/result" && request.method === "POST") {
    // Only fixed fields: the warning text agents see is built here, never taken from the request.
    const body = (await request.json().catch(() => ({}))) as { ok?: unknown; notes?: unknown; run_id?: unknown };
    const runId = /^\d{1,20}$/.test(String(body.run_id ?? "")) ? String(body.run_id) : "unknown";
    await recordBackup(env.DB, device, body.ok === true ? { ok: true, notes: Number(body.notes) || 0 } : { ok: false, error: `GitHub Action run ${runId} failed` });
    return new Response(null, { status: 204 });
  }
  return new Response("Not found", { status: 404 });
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/health") return new Response("ok");
    if (pathname === "/context" && request.method === "GET") return handleContext(request, env);
    if (pathname === "/export" || pathname.startsWith("/export/")) return handleExport(request, env, pathname);
    if (pathname === "/setup/github-app/start" && request.method === "POST") {
      return (await isDevice(request, env)) ? startSetup(env) : unauthorized();
    }
    if (pathname === "/setup/github-app" && request.method === "GET") return setupPage(request, env);
    if (pathname === "/setup/github-app/done" && request.method === "GET") return finishSetup(request, env);
    if (pathname === "/authorize") return handleAuthorize(request, env);
    if (pathname === "/callback") return handleCallback(request, env);
    if (pathname === "/mcp" || pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return mcpResource.fetch(request, env, ctx);
    }
    // Discovery, client registration, token and revocation endpoints.
    return authorizationServer.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
