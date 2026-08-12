import { describe, expect, it } from "vitest";
import { h } from "preact";
import { defineApp, group, prerenderApp, redirect, route, timeRevalidate } from "@pracht/core";
import {
  createISGRegenerationRequest,
  handlePrachtRequest,
  isCacheableISGResponse,
} from "@pracht/core/server";

import { defineI18n } from "../src/index.ts";

const i18n = defineI18n({ locales: ["en", "nl"], defaultLocale: "en" });

function makeApp(render: "ssg" | "isg") {
  return defineApp({
    middleware: { i18n: "./middleware/i18n.ts" },
    routes: [
      group({ middleware: ["i18n"] }, [
        group({ pathPrefix: "/en" }, [
          route("/about", "./routes/about.tsx", {
            render,
            ...(render === "isg" ? { revalidate: timeRevalidate(60) } : {}),
          }),
        ]),
        group({ pathPrefix: "/nl" }, [
          route("/about", "./routes/about.tsx", {
            render,
            ...(render === "isg" ? { revalidate: timeRevalidate(60) } : {}),
          }),
        ]),
      ]),
    ],
  });
}

const registry = {
  middlewareModules: {
    "/src/middleware/i18n.ts": async () => ({ middleware: i18n.middleware }),
  },
  routeModules: {
    "/src/routes/about.tsx": async () => ({
      Component: () => h("main", null, "about"),
      loader: async ({ context }: { context: { locale?: string } }) => ({
        locale: context.locale,
      }),
    }),
  },
};

describe("prerendering locale-prefixed routes", () => {
  it("prerenders every locale's SSG page without baking in Set-Cookie", async () => {
    const pages = await prerenderApp({ app: makeApp("ssg"), registry });
    const paths = pages.map((page) => page.path).sort();
    expect(paths).toEqual(["/en/about", "/nl/about"]);
    for (const page of pages) {
      expect(page.headers?.["set-cookie"]).toBeUndefined();
    }
  });

  it("keeps ISG regeneration responses cacheable", async () => {
    const request = createISGRegenerationRequest("/nl/about");
    const response = await handlePrachtRequest({ app: makeApp("isg"), registry, request });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(isCacheableISGResponse(response)).toBe(true);
  });
});

describe("detector redirects through the middleware chain", () => {
  // The docs tell detector loaders to `return redirect(...)` (not throw):
  // only a returned Response flows back through the middleware, which must
  // stamp `Vary: Cookie, Accept-Language` so a shared cache never replays
  // one visitor's locale redirect to everyone.
  it("stamps Vary on a returned locale redirect", async () => {
    const app = defineApp({
      middleware: { i18n: "./middleware/i18n.ts" },
      routes: [
        group({ middleware: ["i18n"] }, [
          route("/welcome", "./routes/welcome-redirect.tsx", { render: "ssr" }),
        ]),
      ],
    });
    const response = await handlePrachtRequest({
      app,
      registry: {
        ...registry,
        routeModules: {
          "/src/routes/welcome-redirect.tsx": async () => ({
            Component: () => null,
            loader: async ({
              context,
              request,
            }: {
              context: { locale: string };
              request: Request;
            }) => redirect(`/${context.locale}/welcome`, { request }),
          }),
        },
      },
      request: new Request("http://app.test/welcome", {
        headers: { "accept-language": "nl-BE,en;q=0.5" },
      }),
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/nl/welcome");
    const vary = response.headers.get("vary") ?? "";
    expect(vary).toContain("Cookie");
    expect(vary).toContain("Accept-Language");
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});
