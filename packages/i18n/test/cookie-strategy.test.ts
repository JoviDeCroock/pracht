/**
 * The prefix-free ("one URL per page") strategy: locale lives in a cookie and
 * an explicit switch is written by an API route or by the client, never by a
 * URL prefix. These cover the pieces that strategy leans on — `localeCookie`,
 * `setLocaleCookie`, `detectClient`, and the middleware without `"path"`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { defineI18n, type I18nRequestContext } from "../src/index.ts";
import type { MiddlewareArgs } from "@pracht/core";

const i18n = defineI18n({
  locales: ["en", "nl"],
  defaultLocale: "en",
  detect: ["cookie", "header"],
});

async function runMiddleware(
  request: Request,
  instance = i18n,
  route: Record<string, unknown> = { render: "ssr" },
): Promise<{ response: Response; context: I18nRequestContext }> {
  const args = {
    request,
    params: {},
    context: {},
    signal: new AbortController().signal,
    url: new URL(request.url),
    route,
  } as unknown as MiddlewareArgs;
  const response = await instance.middleware(args, () => Promise.resolve(new Response("ok")));
  return { response, context: args.context as unknown as I18nRequestContext };
}

/** Minimal `document.cookie` jar: assignment appends/replaces one pair. */
function fakeDocument(initial: Record<string, string> = {}) {
  const jar = new Map(Object.entries(initial));
  const writes: string[] = [];
  return {
    writes,
    document: {
      get cookie(): string {
        return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
      },
      set cookie(value: string) {
        writes.push(value);
        const [pair = ""] = value.split(";");
        const equals = pair.indexOf("=");
        if (equals === -1) return;
        jar.set(pair.slice(0, equals).trim(), pair.slice(equals + 1).trim());
      },
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("localeCookie", () => {
  it("serializes the same attributes the middleware writes", () => {
    expect(i18n.localeCookie("nl")).toBe(
      "pracht_locale=nl; Path=/; Max-Age=31536000; SameSite=Lax",
    );
  });

  it("infers Secure from an https request url, like the middleware", () => {
    expect(i18n.localeCookie("nl", { url: new URL("https://example.com/greeting") })).toContain(
      "; Secure",
    );
    expect(i18n.localeCookie("nl", { url: "https://example.com/greeting" })).toContain("; Secure");
    expect(i18n.localeCookie("nl", { url: "http://localhost:3000/greeting" })).not.toContain(
      "Secure",
    );
    // An unparseable url must not silently produce a Secure-less cookie
    // *claim* — it simply falls back to "not https".
    expect(i18n.localeCookie("nl", { url: "not a url" })).not.toContain("Secure");
  });

  it("honours an explicit secure option and the configured attributes", () => {
    expect(i18n.localeCookie("nl", { secure: true })).toContain("; Secure");
    const configured = defineI18n({
      locales: ["en", "nl"],
      defaultLocale: "en",
      cookie: { name: "lang", maxAge: 60, path: "/app", sameSite: "Strict", domain: "example.com" },
    });
    expect(configured.localeCookie("nl", { url: "https://example.com/" })).toBe(
      "lang=nl; Path=/app; Max-Age=60; SameSite=Strict; Domain=example.com; Secure",
    );
    expect(
      defineI18n({
        locales: ["en"],
        defaultLocale: "en",
        cookie: { sameSite: "None" },
      }).localeCookie("en"),
    ).toContain("; Secure");
  });

  it("always secures SameSite=None cookies despite explicit false overrides", () => {
    const configured = defineI18n({
      locales: ["en"],
      defaultLocale: "en",
      cookie: { sameSite: "None", secure: false },
    });
    expect(configured.localeCookie("en")).toContain("SameSite=None; Secure");
    expect(configured.localeCookie("en", { secure: false })).toContain("SameSite=None; Secure");
  });

  it("clears the cookie with null, keeping the other attributes so it matches", () => {
    expect(i18n.localeCookie(null)).toBe("pracht_locale=; Path=/; Max-Age=0; SameSite=Lax");
  });

  it("refuses unregistered locales instead of reflecting input", () => {
    expect(() => i18n.localeCookie("zz" as never)).toThrow(/unknown locale "zz"/);
    expect(() => i18n.localeCookie("nl; Domain=evil.com" as never)).toThrow(/unknown locale/);
  });

  it("throws when the cookie is disabled", () => {
    const cookieless = defineI18n({ locales: ["en"], defaultLocale: "en", cookie: false });
    expect(() => cookieless.localeCookie("en")).toThrow(/cookie is disabled/);
    expect(cookieless.cookieName).toBeNull();
  });
});

describe("setLocaleCookie", () => {
  it("writes through document.cookie so the next server render agrees", () => {
    const { document, writes } = fakeDocument();
    vi.stubGlobal("document", document);
    vi.stubGlobal("location", { href: "https://example.com/greeting", pathname: "/greeting" });

    expect(i18n.setLocaleCookie("nl")).toContain("pracht_locale=nl");
    expect(writes).toEqual(["pracht_locale=nl; Path=/; Max-Age=31536000; SameSite=Lax; Secure"]);
    expect(i18n.detectClient()).toEqual({ locale: "nl", source: "cookie" });

    i18n.setLocaleCookie(null);
    expect(writes[1]).toContain("Max-Age=0");
  });

  it("explains itself when there is no document", () => {
    expect(() => i18n.setLocaleCookie("nl")).toThrow(/no `document`/);
  });
});

describe("detectClient", () => {
  it("prefers the cookie, then navigator.languages", () => {
    vi.stubGlobal("location", { href: "http://localhost/greeting", pathname: "/greeting" });
    vi.stubGlobal("navigator", { languages: ["nl-BE", "en"], language: "nl-BE" });
    vi.stubGlobal("document", fakeDocument().document);
    expect(i18n.detectClient()).toEqual({ locale: "nl", source: "header" });

    vi.stubGlobal("document", fakeDocument({ pracht_locale: "en" }).document);
    expect(i18n.detectClient()).toEqual({ locale: "en", source: "cookie" });
  });

  it("falls back to navigator.language and then the default locale", () => {
    vi.stubGlobal("document", fakeDocument().document);
    vi.stubGlobal("navigator", { languages: [], language: "nl" });
    expect(i18n.detectClient()).toEqual({ locale: "nl", source: "header" });

    vi.stubGlobal("navigator", { languages: ["fr", "de"], language: "fr" });
    expect(i18n.detectClient()).toEqual({ locale: "en", source: "default" });
  });

  it("only trusts registered locales from the cookie", () => {
    vi.stubGlobal("navigator", { languages: [], language: "" });
    vi.stubGlobal("document", fakeDocument({ pracht_locale: "zz" }).document);
    expect(i18n.detectClient()).toEqual({ locale: "en", source: "default" });
  });

  it("reads the URL prefix when `path` is in the detection order", () => {
    const prefixed = defineI18n({ locales: ["en", "nl"], defaultLocale: "en" });
    vi.stubGlobal("location", { href: "http://localhost/nl/welcome", pathname: "/nl/welcome" });
    vi.stubGlobal("document", fakeDocument({ pracht_locale: "en" }).document);
    vi.stubGlobal("navigator", { languages: ["en"], language: "en" });
    expect(prefixed.detectClient()).toEqual({ locale: "nl", source: "path" });
  });

  it("returns the default locale during SSR instead of reading Node's navigator", () => {
    // Node ≥21 has a global `navigator` carrying the *server's* language;
    // detecting from it would make server output disagree with the client.
    vi.stubGlobal("navigator", { languages: ["nl"], language: "nl" });
    expect(i18n.detectClient()).toEqual({ locale: "en", source: "default" });
  });
});

describe("prefix-free middleware", () => {
  it("resolves the locale from the cookie without touching the URL", async () => {
    const { response, context } = await runMiddleware(
      new Request("https://example.com/greeting", { headers: { cookie: "pracht_locale=nl" } }),
    );
    expect(context.locale).toBe("nl");
    // One URL per page means shared caches must key on the cookie.
    expect(response.headers.get("vary")).toBe("Cookie");
    // Nothing to persist: the request already carries the choice, and the
    // switcher (API route or client) is what writes it.
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("varies on both sources when the header decides", async () => {
    const { response, context } = await runMiddleware(
      new Request("https://example.com/greeting", {
        headers: { "accept-language": "nl,en;q=0.8" },
      }),
    );
    expect(context.locale).toBe("nl");
    expect(response.headers.get("vary")).toBe("Cookie, Accept-Language");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("never persists a locale on its own, even for a URL that looks prefixed", async () => {
    const { response, context } = await runMiddleware(
      new Request("https://example.com/nl/greeting"),
    );
    expect(context.locale).toBe("en");
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});
