import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    // npm run test:server runs from the repository root: resolve everything from this folder.
    root: import.meta.dirname,
    plugins: [
      cloudflareTest({
        wrangler: { configPath: path.join(import.meta.dirname, "wrangler.test.jsonc") },
        miniflare: {
          bindings: {
            PUBLIC_URL: "http://localhost:8787",
            ALLOWED_GITHUB_USER_ID: "1001",
            MCP_STATE_SECRET: "test-state-secret-0123456789abcdefghijklmnop",
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/apply-migrations.ts"] },
  };
});
