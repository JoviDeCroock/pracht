import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { resolvePrerenderOutputPath } from "../src/commands/build.ts";

describe("resolvePrerenderOutputPath", () => {
  const clientDir = resolve("/tmp/pracht-app/dist/client");

  it("resolves normal prerender routes inside dist/client", () => {
    expect(resolvePrerenderOutputPath(clientDir, "/products/1")).toBe(
      resolve(clientDir, "products/1/index.html"),
    );
  });

  it("resolves the root route to dist/client/index.html", () => {
    expect(resolvePrerenderOutputPath(clientDir, "/")).toBe(resolve(clientDir, "index.html"));
  });

  it("allows non-dot segments that merely start with dots", () => {
    expect(resolvePrerenderOutputPath(clientDir, "/..not-a-dot-segment")).toBe(
      resolve(clientDir, "..not-a-dot-segment/index.html"),
    );
  });

  it("rejects traversal outside dist/client", () => {
    expect(() => resolvePrerenderOutputPath(clientDir, "/../../server/pwned")).toThrow(
      /outside dist\/client/i,
    );
  });

  it("rejects NUL bytes before calling filesystem APIs", () => {
    expect(() => resolvePrerenderOutputPath(clientDir, "/safe\0evil")).toThrow(/NUL byte/);
  });
});
