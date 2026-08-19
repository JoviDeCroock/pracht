import { describe, expect, it } from "vitest";

import { matchAcceptLanguage, parseAcceptLanguage } from "../src/index.ts";

describe("parseAcceptLanguage", () => {
  it("parses tags ordered by q-value with header order breaking ties", () => {
    expect(parseAcceptLanguage("en;q=0.8, nl, fr;q=0.9")).toEqual([
      { tag: "nl", quality: 1 },
      { tag: "fr", quality: 0.9 },
      { tag: "en", quality: 0.8 },
    ]);
  });

  it("lowercases tags and accepts region subtags", () => {
    expect(parseAcceptLanguage("nl-BE, en-US;q=0.5")).toEqual([
      { tag: "nl-be", quality: 1 },
      { tag: "en-us", quality: 0.5 },
    ]);
  });

  it("returns an empty list for null, empty, and whitespace headers", () => {
    expect(parseAcceptLanguage(null)).toEqual([]);
    expect(parseAcceptLanguage("")).toEqual([]);
    expect(parseAcceptLanguage("   ,  ,, ;q=1")).toEqual([]);
  });

  it("drops entries with empty or unparsable q instead of promoting them", () => {
    // `;q=` and `;q=abc` must not beat a well-formed lower preference.
    expect(parseAcceptLanguage("nl;q=, en;q=0.2")).toEqual([{ tag: "en", quality: 0.2 }]);
    expect(parseAcceptLanguage("nl;q=abc, en;q=0.2")).toEqual([{ tag: "en", quality: 0.2 }]);
    expect(parseAcceptLanguage("nl;q=0.5junk, en;q=0.2")).toEqual([{ tag: "en", quality: 0.2 }]);
  });

  it("drops entries with duplicate q parameters instead of reviving them", () => {
    expect(parseAcceptLanguage("nl;q=bogus;q=1, en;q=0.2")).toEqual([{ tag: "en", quality: 0.2 }]);
    expect(parseAcceptLanguage("nl;q=0;q=1, en;q=0.2")).toEqual([{ tag: "en", quality: 0.2 }]);
  });

  it("drops q=0 entries (explicitly not acceptable)", () => {
    expect(parseAcceptLanguage("nl;q=0, en;q=0.1")).toEqual([{ tag: "en", quality: 0.1 }]);
  });

  it("clamps out-of-range q values", () => {
    expect(parseAcceptLanguage("nl;q=9, en;q=-4")).toEqual([{ tag: "nl", quality: 1 }]);
  });

  it("skips malformed tags and garbage bytes", () => {
    expect(parseAcceptLanguage('nl_BE, "en", <script>, ../../etc, 123, en;q=0.5')).toEqual([
      { tag: "en", quality: 0.5 },
    ]);
  });

  it("keeps wildcard entries", () => {
    expect(parseAcceptLanguage("*;q=0.5, en")).toEqual([
      { tag: "en", quality: 1 },
      { tag: "*", quality: 0.5 },
    ]);
  });

  it("caps the number of entries", () => {
    const header = Array.from({ length: 100 }, (_, i) => `aa-x${i}`).join(",");
    expect(parseAcceptLanguage(header).length).toBeLessThanOrEqual(24);
  });

  it("truncates absurdly long headers without throwing", () => {
    const header = `en;q=0.9,${"x".repeat(100_000)}`;
    expect(parseAcceptLanguage(header)).toEqual([{ tag: "en", quality: 0.9 }]);
  });

  it("drops the final entry when the length limit cuts it before its q-value", () => {
    const header = `en;q=0.5,nl;${" ".repeat(2_000)}q=0`;
    expect(parseAcceptLanguage(header)).toEqual([{ tag: "en", quality: 0.5 }]);
  });

  it("ignores q parameters with extra whitespace and case", () => {
    expect(parseAcceptLanguage("en ; Q=0.4")).toEqual([{ tag: "en", quality: 0.4 }]);
  });
});

describe("matchAcceptLanguage", () => {
  const locales = ["en", "nl"] as const;

  it("matches exact tags case-insensitively and returns the registered casing", () => {
    expect(matchAcceptLanguage("NL", locales)).toBe("nl");
    expect(matchAcceptLanguage("en", ["en-US", "en"])).toBe("en");
  });

  it("falls back from a regional tag to its base language", () => {
    expect(matchAcceptLanguage("nl-BE, en;q=0.5", locales)).toBe("nl");
  });

  it("does not let lookup truncation bypass a rejected base locale", () => {
    expect(matchAcceptLanguage("en;q=0, en-US;q=1, nl;q=0.5", locales)).toBe("nl");
    expect(matchAcceptLanguage("en;q=0, en-US;q=1, nl;q=0.5", ["en-GB", "nl"])).toBe("nl");
  });

  it("prefers a longer registered tag matched by the requested range", () => {
    expect(matchAcceptLanguage("en-GB, nl;q=0.5", ["en-US", "en-GB-oxendict", "nl"])).toBe(
      "en-GB-oxendict",
    );
  });

  it("matches a bare language against a registered regional locale", () => {
    expect(matchAcceptLanguage("pt", ["en", "pt-BR"])).toBe("pt-BR");
  });

  it("truncates multi-subtag tags per RFC 4647 lookup", () => {
    // zh-Hant-TW → zh-Hant (not straight to the primary language).
    expect(matchAcceptLanguage("zh-Hant-TW", ["zh-Hant", "zh"])).toBe("zh-Hant");
    expect(matchAcceptLanguage("zh-Hans-CN", ["zh-Hant", "zh"])).toBe("zh");
  });

  it("best-fits a regional tag to a registered locale of the same language", () => {
    // en-GB shares no exact/truncated match with en-US, but a same-language
    // locale beats falling through to a lower-q different language.
    expect(matchAcceptLanguage("en-GB, nl;q=0.9", ["en-US", "nl"])).toBe("en-US");
    // ...while a truly unrelated language still falls through by q-value.
    expect(matchAcceptLanguage("de-AT, nl;q=0.9", ["en-US", "nl"])).toBe("nl");
  });

  it("does not best-fit across conflicting scripts", () => {
    expect(matchAcceptLanguage("zh-Hans, en;q=0.8", ["zh-Hant", "en"])).toBe("en");
    expect(matchAcceptLanguage("zh-Hans", ["zh-Hans-CN", "zh-Hant"])).toBe("zh-Hans-CN");
  });

  it("respects q-value ordering", () => {
    expect(matchAcceptLanguage("nl;q=0.3, en;q=0.9", locales)).toBe("en");
  });

  it("returns null when nothing matches", () => {
    expect(matchAcceptLanguage("de, fr;q=0.5", locales)).toBeNull();
    expect(matchAcceptLanguage(null, locales)).toBeNull();
  });

  it("only ever returns registered locales for hostile input", () => {
    const hostile = "../evil;q=1, javascript:alert(1);q=1, nl;q=0.1";
    expect(matchAcceptLanguage(hostile, locales)).toBe("nl");
  });

  it("resolves wildcard to the provided locale at its q position", () => {
    expect(matchAcceptLanguage("*", locales, { wildcard: "en" })).toBe("en");
    expect(matchAcceptLanguage("*", ["en-US"], { wildcard: "EN-us" })).toBe("en-US");
    expect(matchAcceptLanguage("*;q=0.9, nl;q=0.4", locales, { wildcard: "en" })).toBe("en");
    expect(matchAcceptLanguage("nl;q=0.9, *;q=0.4", locales, { wildcard: "en" })).toBe("nl");
  });

  it("does not let wildcard revive an explicitly rejected locale", () => {
    expect(matchAcceptLanguage("en;q=0, *;q=1", locales, { wildcard: "en" })).toBe("nl");
    expect(matchAcceptLanguage("en;q=0, *;q=1", ["en"], { wildcard: "en" })).toBeNull();
  });

  it("keeps q=0 exclusions after the positive-entry cap", () => {
    const filler = Array.from({ length: 23 }, (_, index) => `zz-x${index};q=0.5`);

    expect(matchAcceptLanguage(["en-US;q=1", ...filler, "en;q=0"].join(","), locales)).toBeNull();
    expect(
      matchAcceptLanguage(["*;q=1", ...filler, "en;q=0"].join(","), locales, {
        wildcard: "en",
      }),
    ).toBe("nl");
  });

  it("ignores wildcard targets outside the registered locale set", () => {
    expect(matchAcceptLanguage("*", locales, { wildcard: "../admin" })).toBeNull();
    expect(matchAcceptLanguage("*;q=0.9, nl;q=0.4", locales, { wildcard: "fr" })).toBe("nl");
  });

  it("ignores wildcard when no wildcard target is configured", () => {
    expect(matchAcceptLanguage("*", locales)).toBeNull();
  });
});
