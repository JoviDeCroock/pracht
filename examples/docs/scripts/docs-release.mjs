import { createHash } from "node:crypto";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const metadataPath = "/.well-known/pracht-build.json";
const requiredPaths = [
  "/docs/why-pracht",
  "/docs/standalone-capabilities",
  "/llms.txt",
  "/llms-full.txt",
  "/.well-known/agent-skills/index.json",
];
const digest = (body) => createHash("sha256").update(body).digest("hex");
export const mcpPath = "/mcp";
const mcpTools = ["docs_search", "docs_read", "docs_list"];

async function filesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory() ? filesIn(path) : [path];
    }),
  );
  return nested.flat();
}

export async function writeRelease(directory, revision) {
  if (!/^[a-f0-9]{40}$/.test(revision ?? "")) throw new Error("A full Git commit SHA is required.");
  const assets = {};
  for (const file of (await filesIn(directory)).sort()) {
    const asset = relative(directory, file).split(sep).join("/");
    if (asset === "404.html" || asset === "200.html") continue;
    if (
      !asset.endsWith(".html") &&
      // llms.txt, llms-full.txt, and each section's full-text file.
      !/^llms(?:-[a-z0-9-]+)?\.txt$/.test(asset) &&
      !asset.startsWith(".well-known/agent-skills/") &&
      !asset.startsWith("skills/")
    )
      continue;
    const path = `/${asset}`.replace(/\/index\.html$/, "").replace(/\.html$/, "") || "/";
    assets[path] = digest(await readFile(file));
  }
  for (const path of requiredPaths) {
    if (!assets[path]) throw new Error(`The docs build is missing ${path}.`);
  }
  const index = JSON.parse(
    await readFile(resolve(directory, ".well-known/agent-skills/index.json"), "utf8"),
  );
  if (!Array.isArray(index.skills)) throw new Error("The docs build has no skill inventory.");
  for (const skill of index.skills) {
    const path = new URL(skill.url).pathname;
    if (!assets[path] || assets[path] !== skill.sha256)
      throw new Error(`The skill index does not match its built source: ${path}.`);
  }
  const release = { revision, assets };
  const file = resolve(directory, `.${metadataPath}`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(release, null, 2)}\n`);
  return release;
}

export async function checkRelease(directory, origin, fetchImpl = fetch, options = {}) {
  const expected = JSON.parse(await readFile(resolve(directory, `.${metadataPath}`), "utf8"));
  const fetchAsset = async (path) => {
    const url = new URL(path, origin);
    url.searchParams.set("pracht_revision", expected.revision);
    const response = await fetchImpl(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}.`);
    return Buffer.from(await response.arrayBuffer());
  };
  const deployed = JSON.parse((await fetchAsset(metadataPath)).toString("utf8"));
  if (deployed.revision !== expected.revision)
    throw new Error(
      `Stale docs deployment: expected ${expected.revision}, received ${deployed.revision}.`,
    );
  // Trust the locally built inventory, never URLs supplied by the deployed site.
  for (const [path, hash] of Object.entries(expected.assets)) {
    if (digest(await fetchAsset(path)) !== hash)
      throw new Error(`Deployed content differs from this build: ${path}.`);
  }
  await checkMcp(origin, expected.assets, fetchImpl, options);
  return expected.revision;
}

/**
 * Drive the docs MCP server the way an MCP host does: handshake, list the
 * tools, and run one search whose hits must be pages this build published.
 * A 5xx, network error, or timeout is retried twice with backoff, since a
 * fresh deployment can still be propagating; anything else fails at once.
 */
export async function checkMcp(origin, assets, fetchImpl = fetch, { retryDelayMs = 1_000 } = {}) {
  let protocolVersion;
  const attempt = async (method, request) => {
    for (let tries = 1; ; tries++) {
      let response;
      try {
        response = await request();
      } catch (error) {
        if (tries >= 3) throw new Error(`MCP ${method} failed: ${error.message}`);
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * 2 ** (tries - 1)));
        continue;
      }
      if (response.status >= 500 && tries < 3) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * 2 ** (tries - 1)));
        continue;
      }
      return response;
    }
  };
  const rpc = async (id, method, params) => {
    const response = await attempt(method, () =>
      fetchImpl(new URL(mcpPath, origin), {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      }),
    );
    if (!response.ok) throw new Error(`MCP ${method} returned HTTP ${response.status}.`);
    const message = await response.json();
    if (message.error) throw new Error(`MCP ${method} failed: ${message.error.message}`);
    return message.result;
  };
  const initialized = await rpc(1, "initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "docs-release", version: "1" },
  });
  protocolVersion = initialized?.protocolVersion;
  const listed = await rpc(2, "tools/list", {});
  const names = (listed?.tools ?? []).map((tool) => tool.name);
  for (const name of mcpTools) {
    if (!names.includes(name)) throw new Error(`The docs MCP server does not list ${name}.`);
  }
  const searched = await rpc(3, "tools/call", {
    name: "docs_search",
    arguments: { query: "capabilities", limit: 3 },
  });
  const results = searched?.structuredContent?.results;
  if (searched?.isError || !Array.isArray(results) || !results.length)
    throw new Error("The docs MCP server returned no docs_search results.");
  for (const result of results) {
    if (!assets[result.page])
      throw new Error(`docs_search returned a page this build did not publish: ${result.page}.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, argument] = process.argv.slice(2);
  const directory = resolve("dist/client");
  if (command === "write") await writeRelease(directory, argument ?? process.env.GITHUB_SHA);
  else if (command === "check")
    console.log(
      `Verified deployed docs at ${await checkRelease(directory, argument ?? "https://pracht.resynapse.dev")}`,
    );
  else throw new Error("Usage: node scripts/docs-release.mjs write <commit-sha> | check [origin]");
}
