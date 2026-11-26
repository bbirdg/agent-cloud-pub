import { defineConfig } from "vitest/config";

// The CLI's tests (Node). The memory server has its own suite: server/vitest.config.ts (Workers runtime).
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    // The tests swap process.cwd and console; files run one at a time.
    fileParallelism: false,
  },
});
