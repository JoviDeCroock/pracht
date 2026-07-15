import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // .claude/skills is a symlink to ../skills; exclude it so
    // skills/skills.test.ts is not discovered (and run) twice.
    exclude: ["**/node_modules/**", "e2e/**", ".claude/**"],
  },
});
