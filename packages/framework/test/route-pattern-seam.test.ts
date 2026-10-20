/**
 * Seam guard for the route-pattern algebra.
 *
 * `route-matching.ts` owns route patterns: parsing (`parseRouteSegments`),
 * matching, covering, overlap, and the first-segment index. Three copies of
 * that algebra once disagreed about percent-decoding, so the conflict warning
 * named routes the matcher could still reach. A new reader that classifies a
 * pattern segment by its text (`startsWith(":")`, `=== "*"`) or a new
 * covers/overlap/index function fails here; work on `RouteSegment`s from
 * `route-matching.ts` instead. The build tools (`@pracht/vite-plugin`, the CLI)
 * are scanned too and use the public `parseRouteSegments()`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packagesDir = fileURLToPath(new URL("../../", import.meta.url));
/** Source directories under the guard, relative to `packages/`. */
const SOURCE_DIRS = ["framework/src", "vite-plugin/src", "cli/src"];
const HOME = "framework/src/route-matching.ts";

/** Files that read pattern text for something other than matching, and why. */
const EXCEPTIONS: Record<string, string> = {
  // Turns a pattern into a route id (`/blog/:slug` -> `blog-slug`); ids are public.
  "framework/src/app.ts": "route id naming",
  // `defineApp({ constraints })` globs, a separate language: `*` is one literal segment.
  "framework/src/constraints.ts": "constraint globs",
  // The islands client matches the server's string table without importing the
  // matcher, which would pull route-matching into a chunk shared with the router.
  "framework/src/islands-navigation.ts": "islands client route table",
  // Cloudflare `_headers` rules, whose `:name` placeholders are not route patterns.
  "cli/src/cloudflare-asset-headers.ts": "Cloudflare _headers placeholders",
};

const SEGMENT_TEXT_READERS = [
  /\.startsWith\(\s*":"\s*\)/,
  /\[0\]\s*===\s*":"/,
  /[sS]egment\s*===\s*"\*"/,
  /"\*"\s*===\s*\w*[sS]egment/,
];

const ALGEBRA_FUNCTIONS =
  /function\s+\w*(?:[Cc]overs\w*Route|[Rr]outes?Covers?|[Pp]atterns?Overlap|[Rr]outes?Overlap|[Ss]egmentsMeet|[Ff]irstSegment|[Ii]ndexSegments|[Rr]outeIndex|[Mm]atchRouteSegments|[Pp]arseRouteSegments)\w*\s*[(<]/;

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const files = SOURCE_DIRS.flatMap((dir) =>
  readdirSync(join(packagesDir, dir), { recursive: true, encoding: "utf8" })
    .filter((file) => /\.tsx?$/.test(file))
    .map((file) => `${dir}/${file.split(sep).join("/")}`),
)
  .filter((file) => file !== HOME)
  .map((file) => ({ file, text: stripComments(readFileSync(join(packagesDir, file), "utf8")) }));

describe("route-pattern algebra seam", () => {
  it("scans the framework, plugin and CLI sources", () => {
    for (const dir of SOURCE_DIRS) {
      expect(files.filter(({ file }) => file.startsWith(`${dir}/`)).length).toBeGreaterThan(20);
    }
    expect(files.map(({ file }) => file)).toContain("vite-plugin/src/pages-router.ts");
    expect(files.map(({ file }) => file)).toContain("cli/src/commands/typegen.ts");
    const home = readFileSync(join(packagesDir, HOME), "utf8");
    expect(home).toMatch(/export function parseRouteSegments\(/);
    expect(home).toMatch(/export function routeCovers\(/);
  });

  it("recognizes a segment-text reader and an algebra function", () => {
    expect(SEGMENT_TEXT_READERS.some((re) => re.test('if (segment.startsWith(":")) {'))).toBe(true);
    expect(SEGMENT_TEXT_READERS.some((re) => re.test('if (lastSegment === "*") {'))).toBe(true);
    expect(ALGEBRA_FUNCTIONS.test("function routeCoversRoute(a, b) {")).toBe(true);
    expect(ALGEBRA_FUNCTIONS.test("function anyFirstSegment(routes) {")).toBe(true);
    expect(ALGEBRA_FUNCTIONS.test("export function getRouteIndex<T>(")).toBe(true);
  });

  it("classifies pattern segments by text only in route-matching.ts", () => {
    const readers = files
      .filter(({ text }) => SEGMENT_TEXT_READERS.some((re) => re.test(text)))
      .map(({ file }) => file);
    expect(readers.filter((file) => !(file in EXCEPTIONS))).toEqual([]);
    // An exception that no longer reads pattern text is stale.
    expect(Object.keys(EXCEPTIONS).filter((file) => !readers.includes(file))).toEqual([]);
  });

  it("defines covers, overlap, and index functions only in route-matching.ts", () => {
    expect(
      files.filter(({ text }) => ALGEBRA_FUNCTIONS.test(text)).map(({ file }) => file),
    ).toEqual([]);
  });
});
