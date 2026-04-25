import { spawn } from "node:child_process";
import { resolve } from "node:path";

const [exampleDir, port] = process.argv.slice(2);

if (!exampleDir || !port) {
  console.error("Usage: node e2e/start-dev-server.mjs <example-dir> <port>");
  process.exit(1);
}

const rootDir = process.cwd();
const cliBin = resolve(rootDir, "packages/cli/bin/pracht.js");
const cwd = resolve(rootDir, exampleDir);
const nodeOptions = [process.env.NODE_OPTIONS, "--experimental-strip-types"]
  .filter(Boolean)
  .join(" ");

const child = spawn(process.execPath, [cliBin, "dev"], {
  cwd,
  env: {
    ...process.env,
    NODE_OPTIONS: nodeOptions,
    PORT: port,
  },
  stdio: "inherit",
});

let shuttingDown = false;

child.on("exit", (code) => {
  process.exit(code ?? 0);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    child.kill(signal);
    setTimeout(() => process.exit(0), 2_000).unref();
  });
}
