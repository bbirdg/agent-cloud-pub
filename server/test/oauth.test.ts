import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setMeta } from "../src/memory";

// The sign-in app's credentials, as the one-click GitHub App setup stores them.
beforeEach(async () => {
  await setMeta(env.DB, "github_client_id", "test-client-id");
  await setMeta(env.DB, "github_client_secret", "test-client-secret");
});

const BASE = "http://localhost:8787";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

function cookiesFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

async function pkce() {
  const verifier = "v".repeat(20) + crypto.randomUUID();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { verifier, challenge };
}

/** Registers a client (DCR), walks consent, and returns GitHub's redirect plus the browser cookies. */
async function startSignIn() {
  const registration = await exports.default.fetch(`${BASE}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
  });
  expect(registration.status).toBe(201);
  const { client_id } = (await registration.json()) as { client_id: string };
  const { verifier, challenge } = await pkce();

  const authorizeUrl = new URL(`${BASE}/authorize`);
  for (const [k, v] of Object.entries({
    response_type: "code",
    client_id,
    redirect_uri: REDIRECT,
    scope: "memory",
    state: "client-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${BASE}/mcp`,
  })) authorizeUrl.searchParams.set(k, v);

  const consent = await exports.default.fetch(authorizeUrl);
  expect(consent.status).toBe(200);
  const html = await consent.text();
  expect(html).toContain("Allow Claude to read and change your agent memory?");
  const handle = /name="handle" value="([^"]+)"/.exec(html)![1]!;
  let cookies = cookiesFrom(consent);

  const approve = await exports.default.fetch(authorizeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookies },
    body: new URLSearchParams({ handle, decision: "approve" }),
    redirect: "manual",
  });
  expect(approve.status).toBe(302);
  const github = new URL(approve.headers.get("Location")!);
  expect(github.origin + github.pathname).toBe("https://github.com/login/oauth/authorize");
  expect(github.searchParams.get("code_challenge_method")).toBe("S256");
  cookies = [cookies, cookiesFrom(approve)].filter(Boolean).join("; ");
  return { client_id, verifier, state: github.searchParams.get("state")!, cookies };
}

function mockGithub(userId: number, login: string) {
  const realFetch = globalThis.fetch;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://github.com/login/oauth/access_token") return Response.json({ access_token: "gh-test-token" });
    if (url === "https://api.github.com/user") return Response.json({ id: userId, login });
    return realFetch(input, init);
  });
}

afterEach(() => vi.restoreAllMocks());

describe("GitHub sign-in for claude.ai", () => {
  it("refuses any GitHub account other than the owner's", async () => {
    const { state, cookies } = await startSignIn();
    mockGithub(2002, "stranger");
    const callback = await exports.default.fetch(`${BASE}/callback?code=abc&state=${encodeURIComponent(state)}`, {
      headers: { Cookie: cookies },
      redirect: "manual",
    });
    expect(callback.status).toBe(302);
    const back = new URL(callback.headers.get("Location")!);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("code")).toBeNull();
  });

  it("issues a token to the owner that works on /mcp", async () => {
    const { client_id, verifier, state, cookies } = await startSignIn();
    mockGithub(1001, "owner");
    const callback = await exports.default.fetch(`${BASE}/callback?code=abc&state=${encodeURIComponent(state)}`, {
      headers: { Cookie: cookies },
      redirect: "manual",
    });
    const back = new URL(callback.headers.get("Location")!);
    const code = back.searchParams.get("code");
    expect(code).toBeTruthy();
    expect(back.searchParams.get("state")).toBe("client-state");

    const tokenResponse = await exports.default.fetch(`${BASE}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        redirect_uri: REDIRECT,
        client_id,
        code_verifier: verifier,
        resource: `${BASE}/mcp`,
      }),
    });
    expect(tokenResponse.status).toBe(200);
    const { access_token } = (await tokenResponse.json()) as { access_token: string };

    const list = await exports.default.fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-06-18",
        Host: "localhost:8787",
        Authorization: `Bearer ${access_token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(list.status).toBe(200);
  });

  it("denies when the user clicks Deny", async () => {
    const registration = await exports.default.fetch(`${BASE}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
    });
    const { client_id } = (await registration.json()) as { client_id: string };
    const { challenge } = await pkce();
    const url = `${BASE}/authorize?response_type=code&client_id=${client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&scope=memory&state=s&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(`${BASE}/mcp`)}`;
    const consent = await exports.default.fetch(url);
    const handle = /name="handle" value="([^"]+)"/.exec(await consent.text())![1]!;
    const denied = await exports.default.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookiesFrom(consent) },
      body: new URLSearchParams({ handle, decision: "deny" }),
      redirect: "manual",
    });
    expect(new URL(denied.headers.get("Location")!).searchParams.get("error")).toBe("access_denied");
  });
});
