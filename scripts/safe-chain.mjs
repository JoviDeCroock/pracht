// Repository dependency commands use a pinned, checksum-verified Safe Chain binary.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const version = "1.5.24";
// SHA-256 digests from the official versioned GitHub release assets.
const assets = {
  "darwin-arm64": [
    "macos-arm64",
    "638932561b1e5e93affbe442567c4144795d0993a83022df02d7833495279f5a",
  ],
  "darwin-x64": ["macos-x64", "6f7c770207bf518f1cabc4ad550a6bf12fb5c746fec468eddc854074ac381e8f"],
  "linux-arm64": [
    "linux-arm64",
    "55f205678c8881d586b5803b2e6ae97f19b5667108aa588e94378db22483fa1b",
  ],
  "linux-x64": ["linux-x64", "5eaba0fb4557c96b6826e1ed9ce0904efb317c9fc43386ad5b7b3282c05446c0"],
  "win32-arm64": [
    "win-arm64.exe",
    "9024654100181c6443dd3610009a45a99c6e9a26454919b6dc8c8693a8ca8ad4",
  ],
  "win32-x64": ["win-x64.exe", "a74f92f1158222fa0fb0c4436463c4eff76236c95662ff860fc45ff1d1da2bb4"],
};
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const binary = resolve(
  repoRoot,
  ".tmp/safe-chain",
  version,
  "bin",
  process.platform === "win32" ? "safe-chain.exe" : "safe-chain",
);

export function verify(bytes, expected) {
  if (createHash("sha256").update(bytes).digest("hex") !== expected) {
    throw new Error(`Safe Chain checksum mismatch. Remove .tmp/safe-chain and retry the command.`);
  }
}

export function parseArgs(input) {
  const args = [...input];
  if (args[0] === "--") args.shift();
  let packageManager = "pnpm";
  if (args[0]?.startsWith("--package-manager=")) {
    packageManager = args.shift().slice("--package-manager=".length);
    if (!["pnpm", "npm"].includes(packageManager)) {
      throw new Error("Safe Chain package manager must be pnpm or npm.");
    }
  }
  return { packageManager, args };
}

export async function ensureBinary(binaryPath, name, checksum) {
  let bytes;
  try {
    bytes = await readFile(binaryPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!bytes) {
    const url = `https://github.com/AikidoSec/safe-chain/releases/download/${version}/safe-chain-${name}`;
    console.log(`Downloading Safe Chain ${version}…`);
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Safe Chain download failed: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    verify(bytes, checksum);
    await mkdir(dirname(binaryPath), { recursive: true });
    const temporary = `${binaryPath}.${process.pid}.tmp`;
    await writeFile(temporary, bytes, { mode: 0o755 });
    await rename(temporary, binaryPath);
  }
  verify(bytes, checksum);
  await chmod(binaryPath, 0o755);
  // Keep upstream's legacy ~/.aikido config lookup out of this local setup.
  // Preserve a config the contributor has already customized here.
  try {
    await writeFile(resolve(dirname(binaryPath), "../config.json"), "{}\n", { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
}

export async function runPackageManager(binaryPath, packageManager, args) {
  const child = spawn(binaryPath, [packageManager, ...args], { stdio: "inherit" });
  return new Promise((resolveChild, rejectChild) => {
    child.on("error", rejectChild);
    child.on("exit", (code, signal) => {
      resolveChild(code ?? (signal === "SIGINT" ? 130 : 1));
    });
  });
}

async function main() {
  const { packageManager, args } = parseArgs(process.argv.slice(2));
  if (args[0] === "--help" || args[0] === "-h") {
    console.log("Usage: pnpm run deps:install [install flags]");
    console.log(
      "       node scripts/safe-chain.mjs [--package-manager=npm] <package manager arguments>",
    );
    console.log("       pnpm run safe:setup");
    return;
  }
  const setupOnly = args.length === 1 && args[0] === "--setup";
  if (args.length === 0) throw new Error("Provide pnpm arguments, e.g. install --frozen-lockfile.");
  const asset = assets[`${process.platform}-${process.arch}`];
  if (!asset)
    throw new Error(`Unsupported Safe Chain platform: ${process.platform}-${process.arch}`);
  await ensureBinary(binary, ...asset);
  if (setupOnly) {
    console.log(`Safe Chain ${version} ready at ${binary}`);
    return;
  }
  process.exitCode = await runPackageManager(binary, packageManager, args);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
