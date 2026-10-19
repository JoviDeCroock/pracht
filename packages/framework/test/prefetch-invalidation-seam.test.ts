/**
 * Seam guard: `clearPrefetchCache()` is the one invalidation hub for
 * prefetched route state, and every client mutation entry point calls it.
 *
 * `prefetch-invalidation.test.ts` drives each entry point listed here. This
 * file makes the next one fail: any framework module that sends a request or
 * listens for a settled capability must be classified below, either as a
 * mutation entry point (and call `clearPrefetchCache()` once per mutation
 * site) or as read-only, with the reason.
 */
import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const srcDir = new URL("../src/", import.meta.url);

/** Module → its mutation sites, each of which must clear the cache. */
const MUTATION_ENTRY_POINTS: Record<string, number> = {
  // apiFetch() with a non-GET method.
  "api-fetch.ts": 1,
  // <Form> submissions: the capability branch and the action branch.
  "runtime-hooks.ts": 2,
  // useRevalidate() / revalidateRouteData().
  "runtime-revalidate.ts": 1,
  // A settled non-read capability, from any dispatch path.
  "runtime-capability-revalidate.ts": 1,
};

/** Module → why its requests or listeners never change server state. */
const READ_ONLY: Record<string, string> = {
  "router.ts": "refetches route state after a mutation; it performs none",
  "runtime-client-fetch.ts": "GETs route state",
  "islands-navigation.ts": "GETs and HEADs documents",
  "server-islands-client.ts": "GETs server-island HTML",
  "islands-client.ts": "an islands page has no client router or prefetch cache",
  "dev-page-tools.ts": "development-only devtools metadata",
  "error-overlay.ts": "development-only open-in-editor request",
};

const REQUEST_OR_LISTENER = [
  /(^|[^A-Za-z_.])(fetch|fetchImpl)\(/m,
  /addEventListener\(\s*CAPABILITY_SETTLED_EVENT/,
  /cache: "reload"/,
];

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const modules = readdirSync(srcDir)
  .filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"))
  .map((file) => ({ file, code: stripComments(readFileSync(new URL(file, srcDir), "utf-8")) }));

describe("prefetch invalidation seam", () => {
  it("classifies every module that sends a request or hears a settled capability", () => {
    const unclassified = modules
      .filter(({ code }) => REQUEST_OR_LISTENER.some((pattern) => pattern.test(code)))
      .map(({ file }) => file)
      .filter((file) => !(file in MUTATION_ENTRY_POINTS) && !(file in READ_ONLY));
    expect(unclassified).toEqual([]);
  });

  it.each(Object.entries(MUTATION_ENTRY_POINTS))(
    "%s clears the prefetch cache at each of its %i mutation sites",
    (file, sites) => {
      const code = modules.find((module) => module.file === file)?.code ?? "";
      expect(code.match(/\bclearPrefetchCache\(\)/g)?.length ?? 0).toBe(sites);
    },
  );

  it("lists no module that no longer exists", () => {
    const files = new Set(modules.map(({ file }) => file));
    for (const file of [...Object.keys(MUTATION_ENTRY_POINTS), ...Object.keys(READ_ONLY)]) {
      expect(files.has(file), file).toBe(true);
    }
  });
});
