/**
 * Seam guard for the route-pattern algebra.
 *
 * `route-matching.ts` owns route patterns: parsing (`parseRouteSegments`),
 * matching, covering, overlap, and the first-segment index. Three copies of
 * that algebra once disagreed about percent-decoding, so the conflict warning
 * named routes the matcher could still reach. A new reader that classifies a
 * pattern segment by its text (`startsWith(":")`, `=== "*"`) or a new
 * covers/overlap/index function fails here; work on `RouteSegment`s from
 * `route-matching.ts` instead.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const srcDir = fileURLToPath(new URL("../src", import.meta.url));
const HOME = "route-matching.ts";

/** Files that read pattern text for something other than matching, and why. */
const EXCEPTIONS: Record<string, string> = {
  // Turns a pattern into a route id (`/blog/:slug` -> `blog-slug`); ids are public.
  "app.ts": "route id naming",
  // `defineApp({ constraints })` globs, a separate language: `*` is one literal segment.
  "constraints.ts": "constraint globs",
  // The islands client matches the server's string table without importing the
  // matcher, which would pull route-matching into a chunk shared with the router.
  "islands-navigation.ts": "islands client route table",
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

const files = readdirSync(srcDir, { recursive: true, encoding: "utf8" })
  .filter((file) => /\.tsx?$/.test(file) && file !== HOME)
  .map((file) => ({ file, text: stripComments(readFileSync(join(srcDir, file), "utf8")) }));

describe("route-pattern algebra seam", () => {
  it("scans the framework sources", () => {
    expect(files.length).toBeGreaterThan(50);
    const home = readFileSync(join(srcDir, HOME), "utf8");
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
