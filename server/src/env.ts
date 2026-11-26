declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      OAUTH_KV: KVNamespace;
      /** Public base URL of this Worker, without a trailing slash. */
      PUBLIC_URL: string;
      /** Optional overrides; normally the one-click GitHub App setup stores these in D1. */
      GITHUB_CLIENT_ID?: string;
      GITHUB_CLIENT_SECRET?: string;
      /** Numeric GitHub user id allowed to sign in through OAuth (claude.ai). */
      ALLOWED_GITHUB_USER_ID?: string;
      /** HMAC key (at least 32 bytes) that signs multi-round-trip requestState; without it confirmation tools are off. */
      MCP_STATE_SECRET?: string;
      /** Private static assets holding skills.json (the user's skills); absent means agent-memory only. */
      SKILLS?: Fetcher;
    }
  }
}

export type Env = Cloudflare.Env;

/** Who is making a request; recorded on every change. */
export interface Actor {
  kind: "device" | "github";
  /** Device name, or "github:<login>". */
  name: string;
  /** Stable identity for binding confirmations: device id, or "github:<numeric user id>". */
  id?: string;
}
