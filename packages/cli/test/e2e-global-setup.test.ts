import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

import { E2E_TEMP_TSCONFIG_CONTENT } from "../../../e2e/global-setup.ts";

const fixture = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/e2e-global-setup-child.mjs",
);

it("atomically publishes one complete TypeScript bridge across simultaneous suites", async () => {
  const tempRoot = mkdtempSync(resolve(tmpdir(), "pracht-e2e-global-setup-"));
  try {
    const exits = Array.from({ length: 8 }, () => {
      const child = spawn(process.execPath, [fixture, tempRoot], {
        env: { PATH: process.env.PATH },
        stdio: "pipe",
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      return new Promise<void>((resolveExit, rejectExit) => {
        child.once("error", rejectExit);
        child.once("exit", (code, signal) => {
          if (code === 0 && signal === null) resolveExit();
          else rejectExit(new Error(`setup exited ${String(code)}/${String(signal)}: ${stderr}`));
        });
      });
    });

    await Promise.all(exits);
    expect(readFileSync(resolve(tempRoot, "tsconfig.json"), "utf8")).toBe(
      E2E_TEMP_TSCONFIG_CONTENT,
    );
    expect(readdirSync(tempRoot)).toEqual(["tsconfig.json"]);
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});
