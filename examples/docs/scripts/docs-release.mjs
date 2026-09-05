import { createHash } from "node:crypto";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const metadataPath = "/.well-known/pracht-build.json";
const requiredPaths = [
  "/docs/why-pracht",
  "/docs/standalone-capabilities",
  "/llms.txt",
  "/.well-known/agent-skills/index.json",
];
const digest = (body) => createHash("sha256").update(body).digest("hex");

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
      asset !== "llms.txt" &&
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

export async function checkRelease(directory, origin, fetchImpl = fetch) {
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
  return expected.revision;
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
