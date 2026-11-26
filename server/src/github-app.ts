import type { Env } from "./env";
import { getMeta, setMeta } from "./memory";

/**
 * One-click creation of the GitHub App used for "Sign in with GitHub" (claude.ai web, Desktop, phone).
 * GitHub's manifest flow hands the app's client id and secret straight to this server, so nobody has
 * to copy them. The app requests no repository permissions: it only identifies who signs in.
 *
 *   POST /setup/github-app/start   (device token)  -> one-time link, valid 15 minutes
 *   GET  /setup/github-app?state=…                   -> sends the browser to GitHub with the manifest
 *   GET  /setup/github-app/done?code=…&state=…       -> GitHub's redirect; stores the credentials
 */

const STATE_KEY = "github_app_setup_state";
const STATE_TTL_MS = 15 * 60 * 1000;

export interface GithubConfig {
  clientId: string;
  clientSecret: string;
  allowedUserId: string;
}

/** Worker secrets win; otherwise the credentials stored by the one-click setup. Null when not set up. */
export async function getGithubConfig(env: Env): Promise<GithubConfig | null> {
  const clientId = env.GITHUB_CLIENT_ID ?? (await getMeta(env.DB, "github_client_id"));
  const clientSecret = env.GITHUB_CLIENT_SECRET ?? (await getMeta(env.DB, "github_client_secret"));
  const allowedUserId = env.ALLOWED_GITHUB_USER_ID;
  return clientId && clientSecret && allowedUserId ? { clientId, clientSecret, allowedUserId } : null;
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem}button{font:inherit;padding:.5rem 1.2rem}</style>${body}`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'" } },
  );
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function readState(db: D1Database): Promise<{ state: string; expires: number } | null> {
  try {
    const raw = await getMeta(db, STATE_KEY);
    return raw ? (JSON.parse(raw) as { state: string; expires: number }) : null;
  } catch {
    return null;
  }
}

async function validState(db: D1Database, state: string | null): Promise<boolean> {
  const saved = await readState(db);
  return !!state && !!saved && saved.state === state && Date.now() < saved.expires;
}

/** Device-token protected. Refuses once the app exists, so it can't be replaced behind your back. */
export async function startSetup(env: Env): Promise<Response> {
  if (await getGithubConfig(env)) return Response.json({ error: "GitHub sign-in is already set up." }, { status: 409 });
  if (!env.ALLOWED_GITHUB_USER_ID) return Response.json({ error: "ALLOWED_GITHUB_USER_ID secret is missing." }, { status: 409 });
  const state = randomHex(24);
  await setMeta(env.DB, STATE_KEY, JSON.stringify({ state, expires: Date.now() + STATE_TTL_MS }));
  return Response.json({ url: `${env.PUBLIC_URL}/setup/github-app?state=${state}`, expires_in_minutes: 15 });
}

export async function setupPage(request: Request, env: Env): Promise<Response> {
  const state = new URL(request.url).searchParams.get("state");
  if (!(await validState(env.DB, state))) return page("Link expired", "<h1>This setup link has expired or was already used.</h1>", 400);
  const base = env.PUBLIC_URL;
  const manifest = {
    name: `agent-memory-${randomHex(3)}`,
    url: base,
    description: "Sign-in for my private agent-memory server. No repository access.",
    callback_urls: [`${base}/callback`],
    redirect_url: `${base}/setup/github-app/done`,
    public: false,
    request_oauth_on_install: false,
    hook_attributes: { url: `${base}/health`, active: false },
    default_permissions: {},
  };
  return page(
    "Create the sign-in app",
    `<h1>Create the GitHub sign-in app</h1>
<p>GitHub will show a page to create a private app called <strong>${escapeHtml(manifest.name)}</strong> with no repository access. Click its green <strong>Create GitHub App</strong> button and you're done.</p>
<form method="post" action="https://github.com/settings/apps/new?state=${escapeHtml(state!)}">
<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
<button>Continue to GitHub</button></form>`,
  );
}

export async function finishSetup(request: Request, env: Env): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const state = params.get("state");
  const code = params.get("code");
  if (!code || !(await validState(env.DB, state))) return page("Link expired", "<h1>This setup link has expired or was already used.</h1>", 400);
  // Claim the single-use link atomically: of two concurrent requests, only one gets changes = 1.
  const claim = await env.DB.prepare("UPDATE meta SET value = NULL WHERE key = ? AND json_extract(value, '$.state') = ?")
    .bind(STATE_KEY, state)
    .run();
  if (claim.meta.changes !== 1) return page("Link expired", "<h1>This setup link has expired or was already used.</h1>", 400);

  const response = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: { Accept: "application/vnd.github+json", "User-Agent": "agent-memory", "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (!response.ok) return page("Setup failed", `<h1>GitHub refused the setup (${response.status}).</h1><p>Start again from a new link.</p>`, 502);
  const app = (await response.json()) as { client_id?: string; client_secret?: string; slug?: string; owner?: { id?: number } };
  if (!app.client_id || !app.client_secret) return page("Setup failed", "<h1>GitHub did not return the app's credentials.</h1>", 502);
  if (env.ALLOWED_GITHUB_USER_ID && String(app.owner?.id) !== env.ALLOWED_GITHUB_USER_ID) {
    return page("Not allowed", "<h1>This app was created by a different GitHub account.</h1>", 403);
  }
  await setMeta(env.DB, "github_client_id", app.client_id);
  await setMeta(env.DB, "github_client_secret", app.client_secret);
  await setMeta(env.DB, "github_app_slug", app.slug ?? null);
  return page("Done", "<h1>Done — GitHub sign-in is ready.</h1><p>You can close this tab and add the connector in claude.ai.</p>");
}
