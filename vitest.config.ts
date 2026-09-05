import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Bound hangs without making subprocess and fixture builds latency assertions.
    testTimeout: 25_000,
    ...(process.env.VITEST_MAX_WORKERS
      ? { maxWorkers: Number(process.env.VITEST_MAX_WORKERS), minWorkers: 1 }
      : {}),
    // .claude/skills is a symlink to ../skills; exclude it so
    // skills/skills.test.ts is not discovered (and run) twice.
    exclude: ["**/node_modules/**", "e2e/**", ".claude/**", ".tmp/**"],
  },
});
