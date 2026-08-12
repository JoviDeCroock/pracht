import { describe, expect, it } from "vitest";

import { defineI18n, type I18nRequestContext } from "../src/index.ts";
import type { MiddlewareArgs } from "@pracht/core";

const i18n = defineI18n({ locales: ["en", "nl"], defaultLocale: "en" });

function makeRequest(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

// The registered app context type is irrelevant here — the middleware only
// writes `locale` — so the args are assembled untyped and cast once.
function middlewareArgs(request: Request, route: Record<string, unknown> = {}): MiddlewareArgs {
  return {
    request,
    params: {},
    context: {},
    signal: new AbortController().signal,
    url: new URL(request.url),
    route,
  } as unknown as MiddlewareArgs;
}

async function runMiddleware(
  request: Request,
  instance = i18n,
  response: () => Response = () => new Response("ok"),
  route: Record<string, unknown> = { render: "ssr" },
): Promise<{ response: Response; context: I18nRequestContext }> {
  const args = middlewareArgs(request, route);
  const result = await instance.middleware(args, () => Promise.resolve(response()));
  return { response: result, context: args.context as unknown as I18nRequestContext };
}

describe("defineI18n config validation", () => {
  it("rejects empty locale lists", () => {
    expect(() => defineI18n({ locales: [], defaultLocale: "en" as never })).toThrow(
      /at least one locale/,
    );
  });

  it("rejects non-BCP47-shaped locales", () => {
    for (const locale of ["", "e", "en/../..", "en nl", "<script>", "en_US", "🇳🇱"]) {
      expect(() => defineI18n({ locales: [locale], defaultLocale: locale as never })).toThrow(
        /invalid locale/,
      );
    }
  });

  it("rejects duplicate locales case-insensitively", () => {
    expect(() => defineI18n({ locales: ["en", "EN"], defaultLocale: "en" })).toThrow(
      /duplicate locale/,
    );
  });

  it("rejects a default locale outside the registry", () => {
    expect(() => defineI18n({ locales: ["en"], defaultLocale: "nl" as never })).toThrow(
      /defaultLocale "nl"/,
    );
  });

  it("rejects unknown detection sources and empty detection orders", () => {
    expect(() => defineI18n({ locales: ["en"], defaultLocale: "en", detect: [] })).toThrow(
      /at least one source/,
    );
    expect(() =>
      defineI18n({
        locales: ["en"],
        defaultLocale: "en",
        detect: ["dns" as never],
      }),
    ).toThrow(/unknown detection source/);
  });

  it("rejects hostile cookie attributes", () => {
    for (const cookie of [
      { name: "bad name" },
      { name: "bad;name" },
      { path: "/x; HttpOnly" },
      { path: "relative" },
      { domain: "a.example;Secure" },
      { maxAge: -1 },
      { maxAge: 1.5 },
    ]) {
      expect(() => defineI18n({ locales: ["en"], defaultLocale: "en", cookie })).toThrow(TypeError);
    }
  });
});

describe("detection", () => {
  it("detects from the URL prefix first by default", () => {
    const request = makeRequest("https://app.test/nl/shop", {
      cookie: "pracht_locale=en",
      "accept-language": "en",
    });
    expect(i18n.detect(request)).toEqual({ locale: "nl", source: "path" });
  });

  it("matches the URL prefix case-insensitively but returns canonical casing", () => {
    const request = makeRequest("https://app.test/NL/shop");
    expect(i18n.detect(request)).toEqual({ locale: "nl", source: "path" });
  });

  it("ignores unregistered path prefixes", () => {
    const request = makeRequest("https://app.test/zz/shop", { "accept-language": "nl" });
    expect(i18n.detect(request)).toEqual({ locale: "nl", source: "header" });
  });

  it("falls back to the cookie, then the Accept-Language header", () => {
    expect(
      i18n.detect(
        makeRequest("https://app.test/shop", {
          cookie: "a=1; pracht_locale=nl; b=2",
          "accept-language": "en",
        }),
      ),
    ).toEqual({ locale: "nl", source: "cookie" });

    expect(
      i18n.detect(makeRequest("https://app.test/shop", { "accept-language": "nl-BE" })),
    ).toEqual({ locale: "nl", source: "header" });
  });

  it("ignores unregistered and malformed cookie values", () => {
    for (const cookie of [
      "pracht_locale=zz",
      "pracht_locale=",
      "pracht_locale",
      "pracht_locale=%2e%2e%2fadmin",
      "pracht_locale=%E0%A4%A", // malformed percent-encoding
      `pracht_locale=${"n".repeat(4000)}`,
    ]) {
      expect(i18n.detect(makeRequest("https://app.test/", { cookie }))).toEqual({
        locale: "en",
        source: "default",
      });
    }
  });

  it("returns the default locale for garbage Accept-Language", () => {
    const request = makeRequest("https://app.test/", {
      "accept-language": ";q=,;;garbage,,de;q=nope",
    });
    expect(i18n.detect(request)).toEqual({ locale: "en", source: "default" });
  });

  it("resolves a wildcard header to the default locale", () => {
    const request = makeRequest("https://app.test/", { "accept-language": "*" });
    expect(i18n.detect(request)).toEqual({ locale: "en", source: "header" });
  });

  it("honors a custom detection order", () => {
    const cookieFirst = defineI18n({
      locales: ["en", "nl"],
      defaultLocale: "en",
      detect: ["cookie", "path"],
    });
    const request = makeRequest("https://app.test/nl/shop", { cookie: "pracht_locale=en" });
    expect(cookieFirst.detect(request)).toEqual({ locale: "en", source: "cookie" });
  });

  it("skips cookie detection entirely when the cookie is disabled", () => {
    const noCookie = defineI18n({ locales: ["en", "nl"], defaultLocale: "en", cookie: false });
    const request = makeRequest("https://app.test/", { cookie: "pracht_locale=nl" });
    expect(noCookie.detect(request)).toEqual({ locale: "en", source: "default" });
    expect(noCookie.cookieName).toBeNull();
  });
});

describe("middleware", () => {
  it("sets context.locale and persists a URL-prefix choice in the cookie", async () => {
    const { response, context } = await runMiddleware(makeRequest("http://app.test/nl/shop"));
    expect(context.locale).toBe("nl");
    expect(response.headers.get("set-cookie")).toBe(
      "pracht_locale=nl; Path=/; Max-Age=31536000; SameSite=Lax",
    );
  });

  it("adds Secure on https requests", async () => {
    const { response } = await runMiddleware(makeRequest("https://app.test/nl/shop"));
    expect(response.headers.get("set-cookie")).toContain("; Secure");
  });

  it("does not rewrite the cookie when it already matches", async () => {
    const { response } = await runMiddleware(
      makeRequest("http://app.test/nl/shop", { cookie: "pracht_locale=nl" }),
    );
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("never sets a cookie for cookie/header/default detections", async () => {
    const cases: Record<string, string>[] = [
      { "accept-language": "nl" },
      { cookie: "pracht_locale=nl" },
      {},
    ];
    for (const headers of cases) {
      const { response } = await runMiddleware(makeRequest("http://app.test/shop", headers));
      expect(response.headers.get("set-cookie")).toBeNull();
    }
  });

  it("never sets a cookie when cookie: false", async () => {
    const noCookie = defineI18n({ locales: ["en", "nl"], defaultLocale: "en", cookie: false });
    const { response, context } = await runMiddleware(
      makeRequest("http://app.test/nl/shop"),
      noCookie,
    );
    expect(context.locale).toBe("nl");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("clones responses with immutable headers instead of throwing", async () => {
    const { response } = await runMiddleware(makeRequest("http://app.test/nl/shop"), i18n, () =>
      Response.redirect("http://app.test/nl/", 302),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("http://app.test/nl/");
    expect(response.headers.get("set-cookie")).toContain("pracht_locale=nl");
  });

  it("applies custom cookie attributes", async () => {
    const custom = defineI18n({
      locales: ["en", "nl"],
      defaultLocale: "en",
      cookie: { name: "locale", maxAge: 60, sameSite: "Strict", domain: "app.test" },
    });
    const { response } = await runMiddleware(makeRequest("http://app.test/nl/"), custom);
    expect(response.headers.get("set-cookie")).toBe(
      "locale=nl; Path=/; Max-Age=60; SameSite=Strict; Domain=app.test",
    );
  });

  it("forces Secure for SameSite=None cookies", async () => {
    const none = defineI18n({
      locales: ["en", "nl"],
      defaultLocale: "en",
      cookie: { sameSite: "None" },
    });
    const { response } = await runMiddleware(makeRequest("http://app.test/nl/"), none);
    expect(response.headers.get("set-cookie")).toContain("SameSite=None; Secure");
  });

  it("never persists the cookie on prerenderable (SSG/ISG) routes", async () => {
    // A Set-Cookie baked into prerendered output fails the SSG build
    // (`assertSafePrerenderHeaders`) and makes every ISG regeneration
    // uncacheable (`isCacheableISGResponse`) — stale content forever.
    for (const render of ["ssg", "isg"]) {
      const { response, context } = await runMiddleware(
        makeRequest("http://app.test/nl/shop"),
        i18n,
        () => new Response("ok"),
        { render },
      );
      expect(context.locale).toBe("nl");
      expect(response.headers.get("set-cookie")).toBeNull();
    }
  });
});

describe("middleware Vary", () => {
  it("adds no Vary when the URL prefix decided first", async () => {
    const { response } = await runMiddleware(makeRequest("http://app.test/nl/shop"));
    expect(response.headers.get("vary")).toBeNull();
  });

  it("varies on Cookie and Accept-Language for unprefixed routes", async () => {
    // Nothing matched → every configured source was consulted.
    const { response } = await runMiddleware(makeRequest("http://app.test/shop"));
    expect(response.headers.get("vary")).toBe("Cookie, Accept-Language");
  });

  it("varies only on the sources consulted up to the winner", async () => {
    const { response } = await runMiddleware(
      makeRequest("http://app.test/shop", { cookie: "pracht_locale=nl" }),
    );
    expect(response.headers.get("vary")).toBe("Cookie");
  });

  it("omits Cookie from Vary when the cookie is disabled", async () => {
    const noCookie = defineI18n({ locales: ["en", "nl"], defaultLocale: "en", cookie: false });
    const { response } = await runMiddleware(
      makeRequest("http://app.test/shop", { "accept-language": "nl" }),
      noCookie,
    );
    expect(response.headers.get("vary")).toBe("Accept-Language");
  });

  it("appends to an existing Vary without duplicating entries", async () => {
    const { response } = await runMiddleware(makeRequest("http://app.test/shop"), i18n, () => {
      return new Response("ok", { headers: { vary: "X-Pracht-Route-State, cookie" } });
    });
    expect(response.headers.get("vary")).toBe("X-Pracht-Route-State, cookie, Accept-Language");
  });

  it("varies redirect responses from the detector route", async () => {
    // The unprefixed detector's 302 target depends on cookie + header; a
    // shared cache replaying it without a key on those would send every
    // visitor to one user's locale.
    const { response } = await runMiddleware(
      makeRequest("http://app.test/welcome", { "accept-language": "nl" }),
      i18n,
      () => Response.redirect("http://app.test/nl/welcome", 302),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("vary")).toBe("Cookie, Accept-Language");
  });

  it("passes protocol-switch responses through untouched", async () => {
    const upgrade = { status: 199, headers: new Headers() } as unknown as Response;
    const { response } = await runMiddleware(
      makeRequest("http://app.test/shop"),
      i18n,
      () => upgrade,
    );
    expect(response).toBe(upgrade);
  });
});

describe("localePath / splitLocale", () => {
  it("prefixes and swaps locale prefixes", () => {
    expect(i18n.localePath("/shop", "nl")).toBe("/nl/shop");
    expect(i18n.localePath("/en/shop", "nl")).toBe("/nl/shop");
    expect(i18n.localePath("/", "en")).toBe("/en");
    expect(i18n.localePath("/nl", "en")).toBe("/en");
  });

  it("preserves query and hash", () => {
    expect(i18n.localePath("/en/shop?page=2#top", "nl")).toBe("/nl/shop?page=2#top");
    expect(i18n.localePath("/?q=1", "nl")).toBe("/nl?q=1");
  });

  it("throws for unregistered locales instead of reflecting them", () => {
    expect(() => i18n.localePath("/shop", "zz" as never)).toThrow(/unknown locale "zz"/);
    expect(() => i18n.localePath("/shop", "../../etc" as never)).toThrow(TypeError);
  });

  it("normalizes protocol-relative-looking paths", () => {
    expect(i18n.localePath("//evil.com/x", "en")).toBe("/en/evil.com/x");
    expect(i18n.localePath("shop", "en")).toBe("/en/shop");
  });

  it("splitLocale only recognizes registered locales", () => {
    expect(i18n.splitLocale("/nl/shop")).toEqual({ locale: "nl", pathname: "/shop" });
    expect(i18n.splitLocale("/NL")).toEqual({ locale: "nl", pathname: "/" });
    expect(i18n.splitLocale("/zz/shop")).toEqual({ locale: null, pathname: "/zz/shop" });
    expect(i18n.splitLocale("/")).toEqual({ locale: null, pathname: "/" });
  });
});

describe("hreflang", () => {
  it("produces alternate links for every locale plus x-default", () => {
    expect(i18n.hreflang("/nl/shop", { origin: "https://app.test" })).toEqual([
      { rel: "alternate", hreflang: "en", href: "https://app.test/en/shop" },
      { rel: "alternate", hreflang: "nl", href: "https://app.test/nl/shop" },
      { rel: "alternate", hreflang: "x-default", href: "https://app.test/shop" },
    ]);
  });

  it("supports relative links when no origin is given", () => {
    expect(i18n.hreflang("/shop")).toEqual([
      { rel: "alternate", hreflang: "en", href: "/en/shop" },
      { rel: "alternate", hreflang: "nl", href: "/nl/shop" },
      { rel: "alternate", hreflang: "x-default", href: "/shop" },
    ]);
  });

  it("can point x-default at a locale or omit it", () => {
    expect(i18n.hreflang("/shop", { xDefault: "en" }).at(-1)).toEqual({
      rel: "alternate",
      hreflang: "x-default",
      href: "/en/shop",
    });
    expect(
      i18n.hreflang("/shop", { xDefault: false }).some((l) => l.hreflang === "x-default"),
    ).toBe(false);
  });

  it("reduces the origin to its actual origin", () => {
    const links = i18n.hreflang("/shop", { origin: "https://user:pw@app.test/base?x=1" });
    expect(links[0]?.href).toBe("https://app.test/en/shop");
  });

  it("rejects invalid or non-http origins", () => {
    expect(() => i18n.hreflang("/shop", { origin: "javascript:alert(1)" })).toThrow(TypeError);
    expect(() => i18n.hreflang("/shop", { origin: "not a url" })).toThrow(TypeError);
  });

  it("never reflects an unregistered path locale into alternates", () => {
    expect(i18n.hreflang("/zz/shop")).toEqual([
      { rel: "alternate", hreflang: "en", href: "/en/zz/shop" },
      { rel: "alternate", hreflang: "nl", href: "/nl/zz/shop" },
      { rel: "alternate", hreflang: "x-default", href: "/zz/shop" },
    ]);
  });
});
