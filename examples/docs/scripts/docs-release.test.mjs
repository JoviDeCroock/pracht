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
    "/llms-full.txt": "# Docs\n\n---\n\n# Page",
    "/llms-agents.txt": "# Docs: Agents",
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
  const mcp = { tools: ["docs_search", "docs_read", "docs_list"], page: "/docs/why-pracht" };
  const fetch = async (url, init) => {
    if (url.pathname === "/mcp") {
      const { id, method } = JSON.parse(init.body);
      const result =
        method === "initialize"
          ? { protocolVersion: "2025-11-25" }
          : method === "tools/list"
            ? { tools: mcp.tools.map((name) => ({ name })) }
            : { structuredContent: { results: [{ page: mcp.page }] }, isError: false };
      return Response.json({ jsonrpc: "2.0", id, result });
    }
    return new Response(files[url.pathname] ?? "missing", {
      status: url.pathname in files ? 200 : 404,
    });
  };
  return { directory, files, fetch, mcp };
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
    "/llms-agents.txt",
    "/.well-known/agent-skills/index.json",
    "/skills/demo/SKILL.md",
  ])("detects stale content at %s despite a current revision marker", async (path) => {
    const { directory, files, fetch } = await fixture();
    files[path] = "old content";
    await expect(checkRelease(directory, "https://docs.invalid", fetch)).rejects.toThrow(path);
  });
  it("fails the publish when the docs MCP server is missing a tool", async () => {
    const { directory, fetch, mcp } = await fixture();
    mcp.tools = ["docs_search", "docs_list"];
    await expect(checkRelease(directory, "https://docs.invalid", fetch)).rejects.toThrow(
      "does not list docs_read",
    );
  });
  it("fails the publish when docs_search points at a page this build lacks", async () => {
    const { directory, fetch, mcp } = await fixture();
    mcp.page = "/docs/removed";
    await expect(checkRelease(directory, "https://docs.invalid", fetch)).rejects.toThrow(
      "/docs/removed",
    );
  });
  it("retries a transient MCP failure", async () => {
    const { directory, fetch } = await fixture();
    const failures = { left: 2 };
    const flaky = async (url, init) => {
      if (url.pathname === "/mcp" && failures.left > 0) {
        failures.left--;
        if (failures.left === 1) return new Response("unavailable", { status: 503 });
        throw new TypeError("fetch failed");
      }
      return fetch(url, init);
    };
    await expect(
      checkRelease(directory, "https://docs.invalid", flaky, { retryDelayMs: 1 }),
    ).resolves.toBe(revision);
    expect(failures.left).toBe(0);
  });
  it("gives up after three attempts, and never retries a 4xx", async () => {
    const { directory, files } = await fixture();
    let calls = 0;
    const respond = (status) => async (url) => {
      if (url.pathname !== "/mcp") return new Response(files[url.pathname] ?? "missing");
      calls++;
      return new Response("nope", { status });
    };
    await expect(
      checkRelease(directory, "https://docs.invalid", respond(502), { retryDelayMs: 1 }),
    ).rejects.toThrow("MCP initialize returned HTTP 502");
    expect(calls).toBe(3);
    calls = 0;
    await expect(
      checkRelease(directory, "https://docs.invalid", respond(400), { retryDelayMs: 1 }),
    ).rejects.toThrow("HTTP 400");
    expect(calls).toBe(1);
  });
  it("fails the publish when the MCP endpoint is not served", async () => {
    const { directory, files } = await fixture();
    const fetch = async (url) =>
      new Response(files[url.pathname] ?? "missing", { status: url.pathname in files ? 200 : 404 });
    await expect(checkRelease(directory, "https://docs.invalid", fetch)).rejects.toThrow(
      "MCP initialize returned HTTP 404",
    );
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
    await writeFile(join(directory, "llms.txt"), "# Docs");
    await rm(join(directory, "llms-full.txt"));
    await expect(writeRelease(directory, revision)).rejects.toThrow("missing /llms-full.txt");
  });
});
