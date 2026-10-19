import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { getManifestHeaders } from "../src/runtime-headers.ts";
import { decodeStaticPath, staticContentType, staticPathCandidates } from "../src/static-path.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("staticPathCandidates", () => {
  it.each([
    ["/", ["/"]],
    ["/assets/app-Ab12.js", ["/assets/app-Ab12.js"]],
    // Decoded first (static exports, `public/`), then the encoded build spelling.
    ["/posts/caf%C3%A9", ["/posts/café", "/posts/caf%C3%A9"]],
    // #471: escape case is not significant; the request's own spelling is last.
    ["/posts/caf%c3%a9", ["/posts/café", "/posts/caf%C3%A9", "/posts/caf%c3%a9"]],
    ["/legal%20terms.txt", ["/legal terms.txt", "/legal%20terms.txt"]],
    // No decoded spelling: an encoded separator, or a lone `%` in a file name.
    ["/posts/a%2Fb", ["/posts/a%2Fb"]],
    ["/posts/a%2fb", ["/posts/a%2Fb", "/posts/a%2fb"]],
    ["/100%.txt", ["/100%.txt"]],
    ["/nul%00", ["/nul%00"]],
  ])("names %s as %j", (pathname, expected) => {
    expect(staticPathCandidates(pathname)).toEqual(expected);
  });

  it.each([
    ["/", ["/index.html"]],
    ["/about", ["/about/index.html"]],
    ["/about/", ["/about/index.html"]],
    [
      "/posts/caf%c3%a9/",
      ["/posts/café/index.html", "/posts/caf%C3%A9/index.html", "/posts/caf%c3%a9/index.html"],
    ],
  ])("names the index of %s as %j", (pathname, expected) => {
    expect(staticPathCandidates(pathname, { index: true })).toEqual(expected);
  });

  it.each([
    "relative",
    "/a/../b",
    "/a/./b",
    "/..",
    "/%2e%2e/etc/passwd",
    "/a/%2E/b",
    "/a\\b",
    "/a\0b",
  ])("refuses %j", (pathname) => {
    expect(staticPathCandidates(pathname)).toBeNull();
    expect(staticPathCandidates(pathname, { index: true })).toBeNull();
  });
});

describe("decodeStaticPath", () => {
  it("decodes per segment", () => {
    expect(decodeStaticPath("/posts/caf%C3%A9")).toEqual({ ok: true, path: "/posts/café" });
    expect(decodeStaticPath("/plain/path")).toEqual({ ok: true, path: "/plain/path" });
  });

  it.each([
    ["/a/%E0%A4%A", "malformed", "%E0%A4%A"],
    ["/a%2Fb", "separator", "a%2Fb"],
    ["/a%5Cb", "separator", "a%5Cb"],
    ["/a%00", "separator", "a%00"],
    ["/%2e%2e", "relative", "%2e%2e"],
    ["/x/..", "relative", ".."],
  ])("reports %s as %s", (pathname, reason, segment) => {
    expect(decodeStaticPath(pathname)).toEqual({ ok: false, reason, segment });
  });
});

describe("staticContentType", () => {
  it.each([
    ["/index.html", "text/html; charset=utf-8"],
    ["app.JS", "application/javascript"],
    ["feed.atom", "application/atom+xml"],
    ["skill.md", "text/markdown; charset=utf-8"],
    ["a/b.c/archive", "application/octet-stream"],
    [".env", "application/octet-stream"],
  ])("serves %s as %s", (file, contentType) => {
    expect(staticContentType(file)).toBe(contentType);
  });

  it("returns the fallback for an unknown extension", () => {
    expect(staticContentType("archive.tar", null)).toBeNull();
    expect(staticContentType("logo.png", null)).toBe("image/png");
  });
});

describe("getManifestHeaders", () => {
  it("matches the build's upper-case escapes for a lower-case request", () => {
    const manifest = { "/posts/caf%C3%A9": { "x-page": "café" } };
    expect(getManifestHeaders(manifest, "/posts/caf%c3%a9")).toEqual({ "x-page": "café" });
    expect(getManifestHeaders(manifest, "/posts/caf%c3%a9/")).toEqual({ "x-page": "café" });
  });
});

// Seam guard: the URL-path-to-file rule has one home. A `decodeURIComponent`
// in an adapter or a build writer is a second copy of it, and a content-type
// table outside static-path.ts is a second MIME table.
describe("static path seam guard", () => {
  function sourceFiles(dir: string, filter: (name: string) => boolean): string[] {
    return readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && filter(entry.name))
      .map((entry) => join(entry.parentPath, entry.name));
  }

  const packagesDir = join(repoRoot, "packages");
  const adapterSources = readdirSync(packagesDir)
    .filter((name) => name.startsWith("adapter-"))
    .flatMap((name) => sourceFiles(join(packagesDir, name, "src"), (file) => file.endsWith(".ts")));
  const buildWriters = sourceFiles(join(packagesDir, "cli", "src"), (file) =>
    /^build-.*\.ts$/.test(file),
  );

  it("finds the files it guards", () => {
    expect(adapterSources.length).toBeGreaterThan(5);
    expect(buildWriters.length).toBeGreaterThan(1);
  });

  it("keeps decodeURIComponent out of adapters and build writers", () => {
    const offenders = [...adapterSources, ...buildWriters]
      .filter((file) => /decodeURI(Component)?\(/.test(readFileSync(file, "utf-8")))
      .map((file) => relative(repoRoot, file));
    expect(offenders).toEqual([]);
  });

  it("keeps one static content-type table", () => {
    const candidates = [
      ...adapterSources,
      ...sourceFiles(join(packagesDir, "vite-plugin", "src"), (file) => file.endsWith(".ts")),
      ...sourceFiles(join(packagesDir, "framework", "src"), (file) => file.endsWith(".ts")),
    ];
    const offenders = candidates
      .filter((file) => !file.endsWith(join("framework", "src", "static-path.ts")))
      .filter((file) => /["']\.woff2["']\s*:/.test(readFileSync(file, "utf-8")))
      .map((file) => relative(repoRoot, file));
    expect(offenders).toEqual([]);
  });
});
