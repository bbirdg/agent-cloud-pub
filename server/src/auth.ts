import {
  AuthorizationError,
  CimdFetchError,
  OAuthAuthorizationServer,
  authorizationErrorRedirect,
  type ConsentDescription,
} from "@cloudflare/workers-oauth-provider";
import { env } from "cloudflare:workers";
import type { Actor, Env } from "./env";
import { type GithubConfig, getGithubConfig } from "./github-app";

export const SCOPES = ["memory", "offline_access"];
export const DEVICE_TOKEN_PREFIX = "amem_";

export const mcpResourceUrl = () => `${env.PUBLIC_URL}/mcp`;

/**
 * The only places a token may be sent. This server has one user, so instead of trusting whoever registers,
 * tokens can only go to Claude's connector callback or an app on the user's own computer.
 */
const ALLOWED_REDIRECT_HOSTS = new Set(["claude.ai", "claude.com"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isAllowedRedirect(uri: string): boolean {
  try {
    const url = new URL(uri);
    if (url.protocol === "https:" && ALLOWED_REDIRECT_HOSTS.has(url.hostname)) return true;
    return (url.protocol === "http:" || url.protocol === "https:") && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

function isAllowedRedirectHost(host: string): boolean {
  const hostname = host.replace(/:\d+$/, "");
  return ALLOWED_REDIRECT_HOSTS.has(hostname) || LOOPBACK_HOSTS.has(hostname);
}

export const authorizationServer = new OAuthAuthorizationServer<Env>({
  issuer: env.PUBLIC_URL,
  resources: [mcpResourceUrl()],
  scopesSupported: SCOPES,
  clientIdMetadataDocumentEnabled: true,
  // Dynamic Client Registration, for clients without CIMD support; limited to allowed redirect targets.
  clientRegistrationEndpoint: "/oauth/register",
  clientRegistrationCallback: ({ clientMetadata }) => {
    const uris = clientMetadata.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || !uris.every((u) => typeof u === "string" && isAllowedRedirect(u))) {
      return {
        code: "invalid_redirect_uri",
        description: "This private server only accepts Claude's connector callback or a loopback address.",
        status: 403,
      };
    }
  },
});

// ---------- device tokens (CLI agents) ----------

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type DeviceScope = "full" | "backup";

/**
 * Returns the device for a valid, unrevoked token whose scope is allowed here ("full" devices may do
 * everything; "backup" devices only reach the /export routes). Touches last_used_at at most once an hour.
 */
export async function validateDeviceToken(db: D1Database, token: string, allowed: DeviceScope[] = ["full"]): Promise<Actor | null> {
  if (!token.startsWith(DEVICE_TOKEN_PREFIX)) return null;
  const hash = await sha256Hex(token);
  const device = await db
    .prepare("SELECT id, name, scope, last_used_at FROM devices WHERE token_hash = ? AND revoked_at IS NULL")
    .bind(hash)
    .first<{ id: string; name: string; scope: DeviceScope; last_used_at: string | null }>();
  if (!device || !allowed.includes(device.scope)) return null;
  if (!device.last_used_at || Date.now() - Date.parse(device.last_used_at) > 3600_000) {
    await db.prepare("UPDATE devices SET last_used_at = ? WHERE id = ?").bind(new Date().toISOString(), device.id).run();
  }
  return { kind: "device", name: device.name, id: device.id };
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match ? match[1]! : null;
}

// ---------- GitHub sign-in (claude.ai web, Desktop, phone) ----------

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string, status = 200, headers = new Headers()): Response {
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a}
button{font:inherit;padding:.5rem 1.2rem;margin-right:.5rem}.warn{color:#a40}</style>
${body}`,
    { status, headers },
  );
}

function consentPage(details: ConsentDescription, handle: string, headers: Headers): Response {
  const origin = details.clientDomain
    ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
    : "This app registered itself; its name is not verified.";
  return page(
    "Allow access to your memory?",
    `<h1>Allow ${escapeHtml(details.clientName)} to read and change your agent memory?</h1>
<p>${origin} Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
<p>It will be able to: ${details.scope.map((s) => `<code>${escapeHtml(s)}</code>`).join(", ") || "<code>memory</code>"} (read, add, change, mute and delete notes${details.scope.includes("offline_access") ? "; stays signed in for up to 30 days" : ""}).</p>
${details.redirectIsLoopback ? '<p class="warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>' : ""}
<p>Next you'll sign in with GitHub. Only the owner's GitHub account is accepted.</p>
<form method="post"><input type="hidden" name="handle" value="${escapeHtml(handle)}">
<button name="decision" value="approve">Allow</button><button name="decision" value="deny">Deny</button></form>`,
    200,
    headers,
  );
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

class NotConfiguredError extends Error {}

async function requireGithubConfig(e: Env): Promise<GithubConfig> {
  const config = await getGithubConfig(e);
  if (!config) throw new NotConfiguredError("GitHub sign-in is not set up yet.");
  return config;
}

/** GET shows the consent page; POST (approved) sends the user to GitHub. */
export async function handleAuthorize(request: Request, e: Env): Promise<Response> {
  const oauth = authorizationServer.getOAuthApi(e);
  try {
    if (request.method === "GET") {
      const authRequest = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(authRequest);
      // Also covers metadata-document (CIMD) clients, which never pass through registration.
      if (!isAllowedRedirectHost(details.redirectHost)) {
        return page(
          "Not allowed",
          `<h1>Not allowed</h1><p>This private memory server only sends access to Claude or to an app on your own computer, not to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>`,
          403,
        );
      }
      const consent = await oauth.beginConsent(authRequest);
      return consentPage(details, consent.handle, consent.headers);
    }
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const form = await request.formData();
    const handle = String(form.get("handle") ?? "");
    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const github = await requireGithubConfig(e);
    const approved = await oauth.approveConsent(request, handle, { scope: SCOPES });
    const verifier = crypto.randomUUID() + crypto.randomUUID();
    const { state, headers } = await oauth.beginUpstream(approved.request, { data: { verifier }, headers: approved.headers });
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", github.clientId);
    url.searchParams.set("redirect_uri", `${e.PUBLIC_URL}/callback`);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", await s256(verifier));
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("allow_signup", "false");
    headers.set("Location", url.toString());
    return new Response(null, { status: 302, headers });
  } catch (error) {
    return renderAuthError(error);
  }
}

/** GitHub redirects here; only the allowed GitHub user id completes authorization. */
export async function handleCallback(request: Request, e: Env): Promise<Response> {
  const oauth = authorizationServer.getOAuthApi(e);
  try {
    const { request: original, data, headers } = await oauth.finishUpstream<{ verifier: string }>(request);
    const params = new URL(request.url).searchParams;
    const deny = () => {
      headers.set("Location", authorizationErrorRedirect(original, "access_denied"));
      return new Response(null, { status: 302, headers });
    };
    const code = params.get("code");
    if (params.get("error") || !code) return deny();

    const github = await requireGithubConfig(e);
    const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: github.clientId,
        client_secret: github.clientSecret,
        code,
        redirect_uri: `${e.PUBLIC_URL}/callback`,
        code_verifier: data.verifier,
      }),
    });
    const token = (await tokenResponse.json()) as { access_token?: string };
    if (!token.access_token) return deny();
    const userResponse = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${token.access_token}`, "User-Agent": "agent-memory", Accept: "application/vnd.github+json" },
    });
    const user = (await userResponse.json()) as { id?: number; login?: string };
    if (!user.id || String(user.id) !== github.allowedUserId) return deny();

    const actor: Actor = { kind: "github", name: `github:${user.login ?? user.id}`, id: `github:${user.id}` };
    const { redirectTo } = await oauth.completeAuthorization({
      request: original,
      userId: String(user.id),
      metadata: {},
      scope: original.scope.filter((s) => SCOPES.includes(s)),
      props: actor,
    });
    headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers });
  } catch (error) {
    return renderAuthError(error);
  }
}

function renderAuthError(error: unknown): Response {
  if (error instanceof NotConfiguredError) {
    return page("Not set up yet", "<h1>Sign-in isn't set up yet</h1><p>Finish the one-click GitHub App setup on your PC, then try again.</p>", 503);
  }
  if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
  if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
    const message = error instanceof AuthorizationError ? error.description : "This app could not be verified.";
    return page("Sign-in problem", `<h1>Sign-in problem</h1><p>${escapeHtml(message ?? "Please start again.")}</p>`, 400);
  }
  throw error;
}
