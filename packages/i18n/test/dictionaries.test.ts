import { describe, expect, it, vi } from "vitest";

import { createDictionaries, interpolate, t, tPlural, type Messages } from "../src/index.ts";

const en = {
  "home.title": "Welcome, {name}",
  "home.subtitle": "Built with pracht",
  "notes.count.one": "{count} note",
  "notes.count.other": "{count} notes",
} as const;

const nl = {
  "home.title": "Welkom, {name}",
  "notes.count.one": "{count} notitie",
  "notes.count.other": "{count} notities",
} as const;

function makeDictionaries() {
  const enLoader = vi.fn(async () => ({ default: en }));
  const nlLoader = vi.fn(async () => ({ default: nl }));
  const dictionaries = createDictionaries({ en: enLoader, nl: nlLoader }, { defaultLocale: "en" });
  return { dictionaries, enLoader, nlLoader };
}

describe("createDictionaries", () => {
  it("exposes locales and defaultLocale", () => {
    const { dictionaries } = makeDictionaries();
    expect(dictionaries.locales).toEqual(["en", "nl"]);
    expect(dictionaries.defaultLocale).toBe("en");
  });

  it("throws when the default locale has no loader", () => {
    expect(() =>
      // @ts-expect-error — defaultLocale must be a registered key
      createDictionaries({ en: () => en }, { defaultLocale: "fr" }),
    ).toThrow(/defaultLocale "fr"/);
  });

  it("loads lazily and caches per locale", async () => {
    const { dictionaries, enLoader, nlLoader } = makeDictionaries();
    expect(enLoader).not.toHaveBeenCalled();

    await dictionaries.load("en");
    await dictionaries.load("en");
    expect(enLoader).toHaveBeenCalledTimes(1);
    expect(nlLoader).not.toHaveBeenCalled();

    await dictionaries.load("nl");
    await dictionaries.load("nl");
    expect(nlLoader).toHaveBeenCalledTimes(1);
    // the default locale backs every merge, so it stays at one load
    expect(enLoader).toHaveBeenCalledTimes(1);
  });

  it("merges missing keys from the default locale", async () => {
    const { dictionaries } = makeDictionaries();
    const messages = await dictionaries.load("nl");
    expect(messages["home.title"]).toBe("Welkom, {name}");
    // `home.subtitle` is missing from nl — falls back to en
    expect(messages["home.subtitle"]).toBe("Built with pracht");
    expect(messages.$locale).toBe("nl");
  });

  it("falls back to the default locale for unknown locales", async () => {
    const { dictionaries } = makeDictionaries();
    const messages = await dictionaries.load("zz");
    expect(messages.$locale).toBe("en");
    expect(messages["home.subtitle"]).toBe("Built with pracht");
  });

  it("produces a plain JSON-serializable object", async () => {
    const { dictionaries } = makeDictionaries();
    const messages = await dictionaries.load("nl");
    const roundTripped = JSON.parse(JSON.stringify(messages)) as typeof messages;
    expect(roundTripped).toEqual(messages);
    expect(t(roundTripped, "home.title", { name: "Jovi" })).toBe("Welkom, Jovi");
  });

  it("accepts modules without a default export", async () => {
    const dictionaries = createDictionaries({ en: () => en }, { defaultLocale: "en" });
    const messages = await dictionaries.load("en");
    expect(messages["home.subtitle"]).toBe("Built with pracht");
  });

  it("strips reserved and non-string entries from dictionaries", async () => {
    const dirty = {
      good: "value",
      $locale: "evil",
      $meta: "reserved",
      bad: 42 as unknown as string,
    };
    const dictionaries = createDictionaries({ en: () => dirty }, { defaultLocale: "en" });
    const messages = await dictionaries.load("en");
    expect(messages.$locale).toBe("en");
    expect(Object.keys(messages).sort()).toEqual(["$locale", "good"]);
  });

  it("retries after a failed import instead of caching the rejection", async () => {
    let attempts = 0;
    const dictionaries = createDictionaries(
      {
        en: () => {
          attempts += 1;
          if (attempts === 1) throw new Error("network");
          return en;
        },
      },
      { defaultLocale: "en" },
    );
    await expect(dictionaries.load("en")).rejects.toThrow("network");
    await expect(dictionaries.load("en")).resolves.toMatchObject({ $locale: "en" });
  });
});

describe("t", () => {
  const messages = { $locale: "en", ...en } as Messages<typeof en>;

  it("translates a key", () => {
    expect(t(messages, "home.subtitle")).toBe("Built with pracht");
  });

  it("interpolates {param} placeholders", () => {
    expect(t(messages, "home.title", { name: "Jovi" })).toBe("Welcome, Jovi");
  });

  it("returns the key for dynamically missing keys", () => {
    expect(t(messages, "nope.missing" as never)).toBe("nope.missing");
  });

  it("never reads `$locale` as a translation", () => {
    expect(t(messages, "$locale" as never)).toBe("$locale");
  });
});

describe("interpolate", () => {
  it("leaves unknown placeholders untouched", () => {
    expect(interpolate("Hi {name}", {})).toBe("Hi {name}");
    expect(interpolate("Hi {name}", undefined)).toBe("Hi {name}");
  });

  it("does not re-interpolate braces inside param values", () => {
    expect(interpolate("Hi {name}", { name: "{evil}", evil: "gotcha" })).toBe("Hi {evil}");
    expect(interpolate("{a}{b}", { a: "{b}", b: "x" })).toBe("{b}x");
  });

  it("coerces numbers and booleans", () => {
    expect(interpolate("{n} / {flag}", { n: 0, flag: false })).toBe("0 / false");
  });

  it("ignores inherited and non-primitive params", () => {
    expect(interpolate("{constructor} {toString}", {})).toBe("{constructor} {toString}");
    expect(interpolate("{x}", { x: { toString: () => "obj" } as unknown as string })).toBe("{x}");
  });
});

describe("tPlural", () => {
  const messages = { $locale: "en", ...en } as Messages<typeof en>;

  it("selects `one` and `other` for English", () => {
    expect(tPlural(messages, "notes.count", 1)).toBe("1 note");
    expect(tPlural(messages, "notes.count", 2)).toBe("2 notes");
    expect(tPlural(messages, "notes.count", 0)).toBe("0 notes");
  });

  it("handles negative and fractional counts", () => {
    // CLDR plural operands use the absolute value; -1 is "one" in English.
    expect(tPlural(messages, "notes.count", -1)).toBe("-1 note");
    expect(tPlural(messages, "notes.count", 1.5)).toBe("1.5 notes");
  });

  it("uses `other` for non-finite counts", () => {
    expect(tPlural(messages, "notes.count", Number.NaN)).toBe("NaN notes");
  });

  it("selects Polish few/many categories", () => {
    const pl = {
      $locale: "pl",
      "items.one": "{count} plik",
      "items.few": "{count} pliki",
      "items.many": "{count} plików",
      "items.other": "{count} pliku",
    };
    expect(tPlural(pl, "items", 1)).toBe("1 plik");
    expect(tPlural(pl, "items", 3)).toBe("3 pliki");
    expect(tPlural(pl, "items", 5)).toBe("5 plików");
    expect(tPlural(pl, "items", 22)).toBe("22 pliki");
  });

  it("falls back to `other` when a category entry is missing", () => {
    const sparse = {
      $locale: "pl",
      "items.other": "{count} rzeczy",
    };
    expect(tPlural(sparse, "items", 2)).toBe("2 rzeczy");
  });

  it("returns the base key when no plural entries exist", () => {
    expect(tPlural(messages, "missing" as never, 2)).toBe("missing");
  });

  it("survives a garbage $locale by falling back to English rules", () => {
    const garbage = {
      $locale: "not a locale!!",
      "items.one": "one",
      "items.other": "other",
    };
    expect(tPlural(garbage, "items", 1)).toBe("one");
    expect(tPlural(garbage, "items", 2)).toBe("other");
  });

  it("exposes {count} and lets it win over params", () => {
    const withParams = {
      $locale: "en",
      "cart.one": "{count} item for {name}",
      "cart.other": "{count} items for {name}",
    };
    expect(tPlural(withParams, "cart", 3, { name: "Jovi", count: 999 })).toBe("3 items for Jovi");
  });
});
