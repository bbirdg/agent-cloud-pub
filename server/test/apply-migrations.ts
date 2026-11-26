import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach } from "vitest";

await applyD1Migrations(env.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);

// Start every test from an empty memory (only the _global project).
beforeEach(async () => {
  await env.DB.batch(
    ["notes", "note_versions", "devices", "audit", "meta", "tasks"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)).concat(
      env.DB.prepare("DELETE FROM projects WHERE key <> '_global'"),
    ),
  );
});
