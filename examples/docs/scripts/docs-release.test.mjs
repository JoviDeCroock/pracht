import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeRelease, checkRelease, metadataPath } from "./docs-release.mjs";

const directories = [];
const revision = "a".repeat(40);
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "pracht-docs-release-"));
  directories.push(directory);
  const files = {
    "/docs/why-pracht": "<html>islands</html>",
    "/docs/standalone-capabilities": "<html>standalone</html>",
    "/llms.txt": "# Docs",
    "/.well-known/agent-skills/index.json": JSON.stringify({
      skills: [
        {
          url: "https://docs.invalid/skills/demo/SKILL.md",
          sha256: createHash("sha256").update("Skill source").digest("hex"),
        },
      ],
    }),
    "/skills/demo/SKILL.md": "Skill source",
  };
  for (const [url, body] of Object.entries(files)) {
    const file = join(directory, url.startsWith("/docs/") ? `${url}/index.html` : url);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, body);
  }
  const release = await writeRelease(directory, revision);
  files[metadataPath] = JSON.stringify(release);
  const fetch = async (url) =>
    new Response(files[url.pathname] ?? "missing", { status: url.pathname in files ? 200 : 404 });
  return { directory, files, fetch };
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
describe("docs publication verification", () => {
  it("verifies the locally built revision, pages, and agent assets", async () => {
    const { directory, fetch } = await fixture();
    await expect(checkRelease(directory, "https://docs.invalid", fetch)).resolves.toBe(revision);
  });
  it("rejects a stale release even when its own files are consistent", async () => {
    const { directory, files, fetch } = await fixture();
    files[metadataPath] = JSON.stringify({ revision: "b".repeat(40) });
    await expect(checkRelease(directory, "https://docs.invalid", fetch)).rejects.toThrow(
      "Stale docs",
    );
  });
  it.each([
    "/docs/why-pracht",
    "/llms.txt",
    "/.well-known/agent-skills/index.json",
    "/skills/demo/SKILL.md",
  ])("detects stale content at %s despite a current revision marker", async (path) => {
    const { directory, files, fetch } = await fixture();
    files[path] = "old content";
    await expect(checkRelease(directory, "https://docs.invalid", fetch)).rejects.toThrow(path);
  });
  it("refuses an index whose skill source is missing", async () => {
    const { directory } = await fixture();
    await rm(join(directory, "skills/demo/SKILL.md"));
    await expect(writeRelease(directory, revision)).rejects.toThrow("skill index does not match");
  });
  it("refuses incomplete local builds", async () => {
    const { directory } = await fixture();
    await rm(join(directory, "llms.txt"));
    await expect(writeRelease(directory, revision)).rejects.toThrow("missing /llms.txt");
  });
});
