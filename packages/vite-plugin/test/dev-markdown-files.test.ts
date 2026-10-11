import { describe, expect, it } from "vitest";

import { EventEmitter } from "node:events";

import type { MarkdownFilePlan, PlanMarkdownFilesOptions } from "@pracht/core";

import { createDevMarkdownPlanCache, findDevMarkdownFile } from "../src/plugin-dev-ssr.ts";

describe("findDevMarkdownFile", () => {
  const plan = {
    files: [
      { markdownPath: "/index.md", pagePath: "/", source: "# Home\n" },
      { markdownPath: "/posts/caf%C3%A9.md", pagePath: "/posts/caf%C3%A9", source: "# Café\n" },
    ],
  };

  it("finds only planned files, matching encoded and decoded spellings", () => {
    expect(findDevMarkdownFile(plan, "/index.md")?.pagePath).toBe("/");
    expect(findDevMarkdownFile(plan, "/posts/caf%C3%A9.md")?.source).toBe("# Café\n");
    expect(findDevMarkdownFile(plan, "/posts/café.md")?.source).toBe("# Café\n");
    expect(findDevMarkdownFile(plan, "/INDEX.md")).toBeUndefined();
    expect(findDevMarkdownFile(plan, "/posts/other.md")).toBeUndefined();
    expect(findDevMarkdownFile(plan, "/%E0%A4%A.md")).toBeUndefined();
  });
});

describe("createDevMarkdownPlanCache", () => {
  function setup(plan: (options: PlanMarkdownFilesOptions) => Promise<MarkdownFilePlan>) {
    const watcher = new EventEmitter();
    const warnings: string[] = [];
    const server = {
      config: {
        logger: { warn: (message: string) => warnings.push(message) },
        plugins: [
          { name: "other" },
          { name: "content", api: { listArtifactPaths: async () => ["/docs/caf%C3%A9.md"] } },
        ],
        publicDir: "",
      },
      watcher,
    };
    const cache = createDevMarkdownPlanCache(
      server as unknown as Parameters<typeof createDevMarkdownPlanCache>[0],
      plan as Parameters<typeof createDevMarkdownPlanCache>[1],
    );
    return { cache, warnings, watcher };
  }

  it("plans once per burst and again after a file change", async () => {
    let calls = 0;
    const { cache, watcher } = setup(async () => {
      calls += 1;
      return { files: [], skipped: [] };
    });
    const serverMod = { resolvedApp: { routes: [] } };
    await Promise.all([cache.get(serverMod), cache.get(serverMod), cache.get(serverMod)]);
    expect(calls).toBe(1);
    watcher.emit("all", "change", "/src/routes/post.tsx");
    await cache.get(serverMod);
    expect(calls).toBe(2);
    await cache.get({ resolvedApp: { routes: [] } });
    expect(calls).toBe(3);
  });

  it("counts content artifacts as files already in the output", async () => {
    let fileExists: PlanMarkdownFilesOptions["fileExists"];
    const { cache } = setup(async (options) => {
      fileExists = options.fileExists;
      return { files: [], skipped: [] };
    });
    await cache.get({ resolvedApp: { routes: [] } });
    expect(fileExists?.("/docs/café.md")).toBe(true);
    expect(fileExists?.("/docs/caf%C3%A9.md")).toBe(true);
    expect(fileExists?.("/docs/other.md")).toBe(false);
  });

  it("plans no files, with a warning, when planning throws", async () => {
    const { cache, warnings } = setup(async () => {
      throw new Error("boom");
    });
    await expect(cache.get({ resolvedApp: { routes: [] } })).resolves.toEqual({
      files: [],
      skipped: [],
    });
    expect(warnings[0]).toContain("boom");
  });
});
