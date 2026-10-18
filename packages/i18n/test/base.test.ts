/**
 * Under a deploy base, the locale prefix is the first segment of the route
 * path, not of the URL: `/my-project/nl/about` is the `nl` page.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function defineUnderBase(base: string) {
  vi.resetModules();
  vi.stubEnv("BASE_URL", base);
  const { defineI18n } = await import("../src/index.ts");
  return defineI18n({ locales: ["en", "nl"], defaultLocale: "en" });
}

describe("path detection under a deploy base", () => {
  it("reads the locale after the base", async () => {
    const i18n = await defineUnderBase("/my-project/");
    const request = new Request("https://example.com/my-project/nl/about", {
      headers: { "accept-language": "en-US" },
    });
    expect(i18n.detect(request)).toEqual({ locale: "nl", source: "path" });
  });

  it("does not mistake the base for a locale", async () => {
    const i18n = await defineUnderBase("/nl/");
    const request = new Request("https://example.com/nl/about", {
      headers: { "accept-language": "en-US" },
    });
    expect(i18n.detect(request)).toEqual({ locale: "en", source: "header" });
  });

  it("reads a path outside the base as it is", async () => {
    const i18n = await defineUnderBase("/my-project/");
    expect(i18n.detect(new Request("https://example.com/nl/about"))).toEqual({
      locale: "nl",
      source: "path",
    });
  });

  it("persists the path locale from the middleware", async () => {
    const i18n = await defineUnderBase("/my-project/");
    const request = new Request("https://example.com/my-project/nl/about");
    const context: Record<string, unknown> = {};
    const response = await i18n.middleware(
      {
        request,
        params: {},
        context,
        signal: new AbortController().signal,
        url: new URL(request.url),
        route: { middlewareFiles: [] },
      } as never,
      () => Promise.resolve(new Response("ok")),
    );
    expect(context.locale).toBe("nl");
    expect(response.headers.get("set-cookie")).toContain("pracht_locale=nl");
  });
});
