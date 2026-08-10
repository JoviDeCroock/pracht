import { existsSync, rmSync } from "node:fs";

/**
 * Remove a test temp directory that a still-running Vite dep optimizer may be
 * writing into.
 *
 * `rmSync`'s own `maxRetries` does not help here: it snapshots the directory
 * with `readdirSync` and then only retries the final `rmdir`, so an entry
 * written *after* that snapshot (`node_modules/.vite/deps_temp_<hash>`) is
 * never removed and every retry fails with the same `ENOTEMPTY`. The optimizer
 * can also recreate the tree moments after a successful removal. Re-running the
 * whole removal until the directory stays gone is what actually converges.
 */
export function removeTempDir(dir: string, attempts = 10, delayMs = 100): void {
  for (let attempt = 1; attempt < attempts; attempt++) {
    try {
      rmSync(dir, { force: true, recursive: true });
      if (!existsSync(dir)) return;
    } catch {
      // Fall through to the retry delay; the final attempt below reports.
    }
    sleepSync(delayMs);
  }
  // Let a genuine failure surface instead of passing silently.
  rmSync(dir, { force: true, recursive: true });
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
