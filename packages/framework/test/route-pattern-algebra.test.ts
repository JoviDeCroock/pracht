import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { islandsNavigationRoutes } from "../src/islands-server.ts";
import { defineApp, resolveApp, route } from "../src/index.ts";
import {
  indexSegments,
  matchIndexedResolvedRoute,
  matchRouteSegments,
  parseRouteSegments,
  routeCovers,
  routesOverlap,
} from "../src/route-matching.ts";
import type { RouteSegment } from "../src/types.ts";

// One oracle for every consumer of the pattern algebra: the matcher itself,
// run over a finite universe of concrete paths. Every pattern below has at most
// three segments before a catch-all, so paths of up to four segments separate
// any two patterns that differ.

const ALPHABET = ["a", "b", "z", "100%", "a%20b", "%E0%A4%A"];
const POOL = ["a", "b", "100%", "a%20b", ":x", "*", ":rest*"];

function sequences(alphabet: readonly string[], maxLength: number): string[][] {
  const out: string[][] = [[]];
  for (let start = 0; out[start]!.length < maxLength; start += 1) {
    for (const value of alphabet) out.push([...out[start]!, value]);
    if (start + 1 >= out.length) break;
  }
  return out.filter((sequence) => sequence.length <= maxLength);
}

const PATHS = sequences(ALPHABET, 4);
const PATTERNS = sequences(POOL, 3).map((segments) => `/${segments.join("/")}`);
const WORDS = Math.ceil(PATHS.length / 32);

/** The paths a pattern matches, as a bitset over `PATHS`. */
const matchSets = new Map<string, Uint32Array>();
for (const pattern of PATTERNS) {
  const segments = parseRouteSegments(pattern);
  const set = new Uint32Array(WORDS);
  PATHS.forEach((path, index) => {
    if (matchRouteSegments(segments, path)) set[index >>> 5]! |= 1 << (index & 31);
  });
  matchSets.set(pattern, set);
}

function meets(a: string, b: string): boolean {
  const left = matchSets.get(a)!;
  const right = matchSets.get(b)!;
  return left.some((word, index) => (word & right[index]!) !== 0);
}

function contains(earlier: string, later: string): boolean {
  const outer = matchSets.get(earlier)!;
  const inner = matchSets.get(later)!;
  return inner.every((word, index) => (word & ~outer[index]!) === 0);
}

/** Seeded mulberry32, so a failure replays from its seed. */
function prng(seed: number): (n: number) => number {
  let state = seed >>> 0;
  return (n) => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) % n) as number;
  };
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("route-pattern algebra", () => {
  it("answers overlap and cover exactly as the matcher does, for every pattern pair", () => {
    const seen = { overlap: 0, disjoint: 0, covers: 0, partial: 0, undecodable: 0 };
    const parsed = new Map(PATTERNS.map((pattern) => [pattern, parseRouteSegments(pattern)]));
    const wrong: string[] = [];
    for (const a of PATTERNS) {
      for (const b of PATTERNS) {
        const overlap = meets(a, b);
        const covers = contains(a, b);
        if (routesOverlap(parsed.get(a)!, parsed.get(b)!) !== overlap) wrong.push(`${a} ∩ ${b}`);
        if (routeCovers(parsed.get(a)!, parsed.get(b)!) !== covers) wrong.push(`${a} ⊇ ${b}`);
        if (overlap) seen.overlap += 1;
        else seen.disjoint += 1;
        if (covers) seen.covers += 1;
        else if (overlap) seen.partial += 1;
        if (!covers && /[:*]/.test(a) && b.includes("100%") && overlap) seen.undecodable += 1;
      }
    }
    expect(wrong).toEqual([]);
    expect(seen.overlap).toBeGreaterThan(10_000);
    expect(seen.disjoint).toBeGreaterThan(10_000);
    expect(seen.covers).toBeGreaterThan(1_000);
    expect(seen.partial).toBeGreaterThan(1_000);
    expect(seen.undecodable).toBeGreaterThan(100);
  });

  it("indexes a superset of the matching and overlapping patterns, in order", () => {
    const random = prng(462);
    const wrong: string[] = [];
    let fallback = 0;
    for (let table = 0; table < 150; table += 1) {
      const patterns = Array.from(
        { length: 1 + random(16) },
        () => PATTERNS[random(PATTERNS.length)]!,
      );
      const segments = patterns.map(parseRouteSegments);
      const index = indexSegments(segments.slice(0, 1).map((s) => ({ segments: s })));
      for (const s of segments.slice(1)) index.add(s);

      for (const path of PATHS.filter((_, at) => at % 3 === table % 3)) {
        const candidates = index.candidates(path);
        if (candidates.some((id, at) => at > 0 && id <= candidates[at - 1]!)) {
          wrong.push(`unordered ${path.join("/")}`);
        }
        segments.forEach((s, id) => {
          if (matchRouteSegments(s, path) && !candidates.includes(id)) {
            wrong.push(`${patterns[id]} misses /${path.join("/")}`);
          }
        });
      }
      for (const pattern of PATTERNS.slice(0, 120)) {
        const query = parseRouteSegments(pattern);
        const overlapping = index.overlapping(query);
        if (overlapping.length === patterns.length) fallback += 1;
        patterns.forEach((other, id) => {
          if (meets(pattern, other) && !overlapping.includes(id)) {
            wrong.push(`${pattern} misses ${other}`);
          }
        });
      }
    }
    expect(wrong).toEqual([]);
    expect(fallback).toBeGreaterThan(50);
  });

  it("matches the first declared route, like a linear scan", () => {
    const random = prng(7);
    const wrong: string[] = [];
    for (let table = 0; table < 100; table += 1) {
      const paths = Array.from(
        { length: 1 + random(12) },
        () => PATTERNS[random(PATTERNS.length)]!,
      );
      const app = resolveApp(
        defineApp({
          routes: paths.map((path, index) => route(path, `./r${index}.tsx`, { id: `r${index}` })),
        }),
      );
      for (const path of PATHS.filter((_, at) => at % 3 === table % 3)) {
        const pathname = `/${path.join("/")}`;
        const scan = app.routes.find((candidate) => matchRouteSegments(candidate.segments, path));
        const indexed = matchIndexedResolvedRoute(app, pathname)?.route.id;
        if (indexed !== scan?.id) wrong.push(`${pathname} in ${paths.join(" ")}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("warns about exactly the routes an earlier route covers", () => {
    const random = prng(461);
    let warned = 0;
    let quiet = 0;
    for (let table = 0; table < 300; table += 1) {
      warn.mockClear();
      const paths = Array.from(
        { length: 1 + random(10) },
        () => PATTERNS[random(PATTERNS.length)]!,
      );
      resolveApp(
        defineApp({
          routes: paths.map((path, index) => route(path, `./r${index}.tsx`, { id: `r${index}` })),
        }),
      );
      const expected = paths.flatMap((path, index) => {
        const earlier = paths.findIndex((other, at) => at < index && contains(other, path));
        return earlier === -1 ? [] : [`r${index}<r${earlier}`];
      });
      const actual = warn.mock.calls.flatMap((call) => {
        const found =
          /\(\.\/r(\d+)\.tsx\) can never match: the earlier route "[^"]*" \(\.\/r(\d+)/.exec(
            String(call[0]),
          );
        return found ? [`r${found[1]}<r${found[2]}`] : [];
      });
      expect(actual, paths.join(" ")).toEqual(expected);
      if (expected.length > 0) warned += 1;
      if (paths.length > 1 && expected.length === 0) quiet += 1;
    }
    expect(warned).toBeGreaterThan(50);
    expect(quiet).toBeGreaterThan(50);
  });

  it("keeps exactly the islands-table blockers some later islands route overlaps", () => {
    const random = prng(466);
    let kept = 0;
    let dropped = 0;
    for (let table = 0; table < 300; table += 1) {
      const api = Array.from({ length: random(3) }, () => PATTERNS[random(PATTERNS.length)]!);
      const pages = Array.from({ length: 1 + random(10) }, () => ({
        path: PATTERNS[random(PATTERNS.length)]!,
        islands: random(2) === 1,
      }));
      const app = resolveApp(
        defineApp({
          routes: pages.map(({ path, islands }, index) =>
            route(path, `./r${index}.tsx`, {
              id: `r${index}`,
              hydration: islands ? "islands" : "full",
            }),
          ),
        }),
      );
      const all = [
        ...api.map((path) => `-${path}`),
        ...pages.map(({ path, islands }) => `${islands ? "+" : "-"}${path}`),
      ];
      const pairwise = all.filter(
        (entry, index) =>
          entry[0] === "+" ||
          all
            .slice(index + 1)
            .some((later) => later[0] === "+" && meets(entry.slice(1), later.slice(1))),
      );
      const apiRoutes = api.map((path, index) => ({
        path,
        file: `./api${index}.ts`,
        segments: parseRouteSegments(path) as RouteSegment[],
      }));
      expect(islandsNavigationRoutes(app, apiRoutes), all.join(" ")).toEqual(pairwise);
      if (pairwise.some((entry) => entry[0] === "-")) kept += 1;
      if (all.some((entry) => entry[0] === "-" && !pairwise.includes(entry))) dropped += 1;
    }
    expect(kept).toBeGreaterThan(50);
    expect(dropped).toBeGreaterThan(50);
  });
});
