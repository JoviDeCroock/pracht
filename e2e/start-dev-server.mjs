import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";

const [exampleDir, port] = process.argv.slice(2);

if (!exampleDir || !port) {
  console.error("Usage: node e2e/start-dev-server.mjs <example-dir> <port>");
  process.exit(1);
}

const rootDir = process.cwd();
const cliBin = resolve(rootDir, "packages/cli/bin/pracht.js");
const sourceDir = resolve(rootDir, exampleDir);
const leasePath = process.env.PRACHT_E2E_LEASE_PATH;
const cwd = leasePath ? resolve(leasePath, exampleDir) : sourceDir;
const nodeOptions = [process.env.NODE_OPTIONS, "--experimental-strip-types"]
  .filter(Boolean)
  .join(" ");
const excludedFixtureEntries = new Set([".vercel", ".wrangler", "dist", "test-results"]);

if (leasePath) {
  mkdirSync(dirname(cwd), { recursive: true });
  try {
    // examples/basic has a dedicated program extending ../../tsconfig.json.
    // Preserve that relationship inside the suite root without copying the
    // workspace configuration or changing the example.
    writeFileSync(
      resolve(leasePath, "tsconfig.json"),
      `${JSON.stringify({ extends: resolve(rootDir, "tsconfig.json") }, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }

  try {
    cpSync(sourceDir, cwd, {
      filter(source) {
        const path = relative(sourceDir, source);
        return !excludedFixtureEntries.has(path.split(sep)[0]);
      },
      recursive: true,
    });
  } catch (error) {
    rmSync(cwd, { force: true, recursive: true });
    throw error;
  }
}
// Playwright can terminate web-server wrappers without delivering a catchable
// signal. Nest caches below the suite lease when one is available: the config
// process owns that directory and releases it only after every web server has
// stopped. Direct/manual launches still use the OS temp directory and the
// eager cleanup hooks below.
const cacheRoot = process.env.PRACHT_E2E_LEASE_PATH ?? tmpdir();
const cacheDir = mkdtempSync(resolve(cacheRoot, "pracht-e2e-vite-cache-"));

let cleanedUp = false;
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  rmSync(cacheDir, { force: true, recursive: true });
  if (leasePath) {
    rmSync(cwd, { force: true, recursive: true });
  }
}

let child;
try {
  child = spawn(process.execPath, [cliBin, "dev", "--cache-dir", cacheDir], {
    cwd,
    env: {
      ...process.env,
      NODE_OPTIONS: nodeOptions,
      PORT: port,
    },
    stdio: "inherit",
  });
} catch (error) {
  cleanup();
  throw error;
}

let shuttingDown = false;

process.once("exit", cleanup);
child.once("error", (error) => {
  console.error(error);
  cleanup();
  process.exit(1);
});
child.once("exit", (code, signal) => {
  cleanup();
  process.exitCode = code ?? (shuttingDown ? 0 : signal ? 1 : 0);
});

for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    child.kill(signal);
    setTimeout(() => {
      child.kill("SIGKILL");
    }, 2_000).unref();
  });
}
