// Publish pracht's MCP servers to the official MCP Registry.
//
// Idempotent: each server.json is published only when the registry does not
// already list its version, and only once the thing it points at is live — the
// npm version (with a matching `mcpName`) for package servers, an answering
// endpoint for remote servers. npm releases are staged and approved by hand, so
// this runs on a schedule instead of right after `changeset publish`.
//
// Usage: node .github/scripts/publish-mcp-registry.mjs <mcp-publisher> [--dry-run]

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REGISTRY = "https://registry.modelcontextprotocol.io";

const SERVERS = [
  { file: "packages/cli/server.json", versionFrom: "packages/cli/package.json" },
  { file: "examples/docs/server.json" },
];

const [publisher, ...flags] = process.argv.slice(2);
const dryRun = flags.includes("--dry-run");
if (!publisher) {
  console.error("Usage: publish-mcp-registry.mjs <path-to-mcp-publisher> [--dry-run]");
  process.exit(1);
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

function withVersion(server, version) {
  return {
    ...server,
    version,
    packages: server.packages?.map((pkg) => ({ ...pkg, version })),
  };
}

async function isRegistered(name, version) {
  const url = `${REGISTRY}/v0/servers/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`;
  const response = await fetch(url);
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return true;
}

async function packageIsLive(pkg, mcpName) {
  if (pkg.registryType !== "npm") return true;
  const url = `https://registry.npmjs.org/${pkg.identifier.replace("/", "%2f")}/${pkg.version}`;
  const response = await fetch(url);
  if (!response.ok) return `${pkg.identifier}@${pkg.version} is not on npm yet`;
  const manifest = await response.json();
  if (manifest.mcpName !== mcpName) {
    return `${pkg.identifier}@${pkg.version} has mcpName ${JSON.stringify(manifest.mcpName)}, expected ${JSON.stringify(mcpName)}`;
  }
  return true;
}

async function remoteIsLive(remote) {
  const response = await fetch(remote.url, {
    method: "POST",
    headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "pracht-registry-check", version: "1.0.0" },
      },
    }),
  });
  return response.ok ? true : `${remote.url} answered ${response.status}`;
}

const pending = [];
for (const entry of SERVERS) {
  let server = readJson(entry.file);
  if (entry.versionFrom) server = withVersion(server, readJson(entry.versionFrom).version);

  if (await isRegistered(server.name, server.version)) {
    console.log(`${server.name}@${server.version} is already registered.`);
    continue;
  }

  const checks = await Promise.all([
    ...(server.packages ?? []).map((pkg) => packageIsLive(pkg, server.name)),
    ...(server.remotes ?? []).map((remote) => remoteIsLive(remote)),
  ]);
  const blocker = checks.find((result) => result !== true);
  if (blocker) {
    console.log(`Skipping ${server.name}@${server.version}: ${blocker}.`);
    continue;
  }
  pending.push(server);
}

if (pending.length === 0) {
  console.log("Nothing to publish.");
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), "mcp-registry-"));
if (!dryRun) execFileSync(publisher, ["login", "github-oidc"], { stdio: "inherit" });
for (const server of pending) {
  const file = join(dir, `${server.name.replace(/[^a-z0-9]+/gi, "-")}.json`);
  writeFileSync(file, `${JSON.stringify(server, null, 2)}\n`);
  if (dryRun) {
    console.log(`Would publish ${server.name}@${server.version}.`);
    execFileSync(publisher, ["validate", file], { stdio: "inherit" });
    continue;
  }
  execFileSync(publisher, ["publish", file], { stdio: "inherit" });
}
