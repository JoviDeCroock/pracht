import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defineCapability } from "@pracht/capabilities";

import { createContentPageCapability, createContentSearchCapability } from "../src/capabilities.ts";
import { defineCollection } from "../src/index.ts";

let temporaryDirectory: string | undefined;

afterEach(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { force: true, recursive: true });
  temporaryDirectory = undefined;
});

describe("content capabilities", () => {
  it("keeps page and basic search generation opt-in and private by default", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "pracht-content-capabilities-"));
    await writeFile(
      join(temporaryDirectory, "guide.md"),
      "---\ntitle: Deployment Guide\n---\nDeploy safely with an adapter.",
    );
    await writeFile(join(temporaryDirectory, "other.md"), "Unrelated text.");
    const collection = defineCollection({
      name: "docs",
      root: temporaryDirectory,
      routeBase: "/docs",
    });
    const pageFields = createContentPageCapability(collection);
    const searchFields = createContentSearchCapability(collection);
    const page = defineCapability({
      title: "Read docs page",
      description: "Read one docs page.",
      effect: "read",
      ...pageFields,
    });
    const search = defineCapability({
      title: "Search docs",
      description: "Search the docs collection.",
      effect: "read",
      ...searchFields,
    });
    const request = new Request("https://example.com");
    const signal = new AbortController().signal;

    expect(page.expose).toBeNull();
    await expect(
      page.run({ context: {}, input: { path: "/docs/guide" }, request, signal }),
    ).resolves.toMatchObject({
      content: "Deploy safely with an adapter.",
      found: true,
      title: "Deployment Guide",
    });
    await expect(
      search.run({ context: {}, input: { query: "deploy adapter" }, request, signal }),
    ).resolves.toEqual({
      results: [
        expect.objectContaining({ path: "/docs/guide", score: 12, title: "Deployment Guide" }),
      ],
    });
  });
});
