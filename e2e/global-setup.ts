import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const E2E_TEMP_TSCONFIG_CONTENT = `${JSON.stringify({ extends: "../tsconfig.json" }, null, 2)}\n`;

/** Atomically publish the immutable bridge shared by disposable build fixtures. */
export function ensureE2ETempTsconfigBridge(tempRoot: string): void {
  mkdirSync(tempRoot, { recursive: true });
  const bridgePath = resolve(tempRoot, "tsconfig.json");
  const temporaryPath = resolve(tempRoot, `.tsconfig-${process.pid}-${randomUUID()}.json.tmp`);
  writeFileSync(temporaryPath, E2E_TEMP_TSCONFIG_CONTENT, { encoding: "utf8", flag: "wx" });

  try {
    // Hard-link creation is atomic and never replaces an existing bridge. A
    // concurrent suite therefore sees either no file or one complete file.
    linkSync(temporaryPath, bridgePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (readFileSync(bridgePath, "utf8") !== E2E_TEMP_TSCONFIG_CONTENT) {
      throw new Error(`Unexpected shared E2E TypeScript bridge contents at ${bridgePath}.`);
    }
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

export default function globalSetup(): void {
  const tempRoot = resolve(repoRoot, ".tmp");

  // Several build specs copy examples/basic to .tmp/<case>/project. Keep the
  // example's real ../../tsconfig.json relationship intact by providing the
  // equivalent parent config for those isolated copies. Concurrent suites
  // atomically share the same deterministic, immutable bridge.
  ensureE2ETempTsconfigBridge(tempRoot);
}
