import { describe, expect, it } from "vitest";

import {
  closestName,
  formatUnknownNameError,
  levenshteinDistance,
} from "../src/name-suggestions.ts";

describe("levenshteinDistance", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshteinDistance("public", "public")).toBe(0);
    expect(levenshteinDistance("", "")).toBe(0);
  });

  it("returns the other string's length when one side is empty", () => {
    expect(levenshteinDistance("", "auth")).toBe(4);
    expect(levenshteinDistance("auth", "")).toBe(4);
  });

  it("counts substitutions, insertions, and deletions", () => {
    expect(levenshteinDistance("kitten", "sitting")).toBe(3);
    expect(levenshteinDistance("pubic", "public")).toBe(1);
    expect(levenshteinDistance("auht", "auth")).toBe(2);
    expect(levenshteinDistance("flaw", "lawn")).toBe(2);
  });

  it("is symmetric", () => {
    expect(levenshteinDistance("shell", "shells")).toBe(levenshteinDistance("shells", "shell"));
  });
});

describe("closestName", () => {
  it("suggests the closest registered name", () => {
    expect(closestName("pubic", ["public", "app"])).toBe("public");
    expect(closestName("auht", ["auth", "logging"])).toBe("auth");
  });

  it("matches case-insensitively but returns the registered casing", () => {
    expect(closestName("PUBLIC", ["public", "app"])).toBe("public");
  });

  it("returns undefined when nothing is a plausible typo", () => {
    expect(closestName("dashboard", ["auth", "log"])).toBeUndefined();
  });

  it("returns undefined for an empty candidate list", () => {
    expect(closestName("public", [])).toBeUndefined();
  });
});

describe("formatUnknownNameError", () => {
  it("includes the suggestion, context, and registered names", () => {
    expect(
      formatUnknownNameError({
        kind: "shell",
        name: "pubic",
        registered: ["public", "app"],
        context: 'route "/"',
      }),
    ).toBe(
      'Unknown shell "pubic" for route "/". Did you mean "public"? Registered shells: public, app.',
    );
  });

  it("omits the suggestion when nothing is close", () => {
    expect(
      formatUnknownNameError({
        kind: "shell",
        name: "dashboard",
        registered: ["auth"],
        context: 'route "/x"',
      }),
    ).toBe('Unknown shell "dashboard" for route "/x". Registered shells: auth.');
  });

  it("supports an explicit plural label", () => {
    expect(
      formatUnknownNameError({
        kind: "middleware",
        kindPlural: "middleware",
        name: "athu",
        registered: ["auth"],
        context: "api routes",
      }),
    ).toBe(
      'Unknown middleware "athu" for api routes. Did you mean "auth"? Registered middleware: auth.',
    );
  });

  it("says when nothing is registered at all", () => {
    expect(
      formatUnknownNameError({
        kind: "shell",
        name: "public",
        registered: [],
      }),
    ).toBe('Unknown shell "public". No shells are registered in defineApp().');
  });
});
