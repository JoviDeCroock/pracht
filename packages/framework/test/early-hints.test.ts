import { h } from "preact";
import { describe, expect, it } from "vitest";

import {
  defineApp,
  defineFont,
  handlePrachtRequest,
  notFound,
  redirect,
  route,
  type HeadMetadata,
} from "../src/index.ts";
import { documentPreloadLinks, MAX_PRELOAD_LINK_HEADER_LENGTH } from "../src/runtime-html.ts";

const manifests = {
  clientEntryUrl: "/assets/client.js",
  cssManifest: {
    "src/routes/home.tsx": ["/assets/home.css"],
    "src/shells/app.tsx": ["/assets/app.css"],
  },
  jsManifest: {
    "src/routes/home.tsx": ["/assets/home.js", "/assets/vendor.js"],
    "src/shells/app.tsx": ["/assets/app.js", "/assets/vendor.js"],
  },
};

const stylesheetLinks = [
  "</assets/app.css>; rel=preload; as=style",
  "</assets/home.css>; rel=preload; as=style",
];

const homeLinks = [
  ...stylesheetLinks,
  "</assets/client.js>; rel=modulepreload",
  "</assets/app.js>; rel=modulepreload",
  "</assets/vendor.js>; rel=modulepreload",
  "</assets/home.js>; rel=modulepreload",
];

function homeApp(options: { hydration?: "full" | "islands" | "none"; middleware?: string[] } = {}) {
  return defineApp({
    shells: { app: "./shells/app.tsx" },
    middleware: { gate: "./middleware/gate.ts" },
    routes: [route("/", "./routes/home.tsx", { shell: "app", ...options })],
  });
}

function registry(
  overrides: { loader?: () => unknown; head?: () => HeadMetadata; gate?: () => unknown } = {},
) {
  return {
    routeModules: {
      "./routes/home.tsx": async () => ({
        Component: () => h("main", null, "Home"),
        ...(overrides.loader ? { loader: overrides.loader } : {}),
        ...(overrides.head ? { head: overrides.head } : {}),
      }),
    },
    shellModules: {
      "./shells/app.tsx": async () => ({
        Shell: ({ children }: { children?: unknown }) => h("div", null, children as never),
      }),
    },
    middlewareModules: {
      "./middleware/gate.ts": async () => ({
        middleware: async (_args: unknown, next: () => Promise<Response>) =>
          (overrides.gate?.() as Response | undefined) ?? next(),
      }),
    },
  };
}

describe("document Link header", () => {
  it("lists the stylesheets and leaves module preloads to the document", async () => {
    const response = await handlePrachtRequest({
      app: homeApp(),
      registry: registry(),
      request: new Request("http://localhost/"),
      ...manifests,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("link")).toBe(stylesheetLinks.join(", "));
    expect(await response.text()).toContain('<link rel="modulepreload" href="/assets/home.js">');
  });

  it("adds defineFont() preloads after the stylesheets", async () => {
    const font = defineFont({ family: "Heading", src: "/fonts/heading.woff2" });
    const response = await handlePrachtRequest({
      app: homeApp(),
      registry: registry({ head: () => ({ fonts: [font] }) }),
      request: new Request("http://localhost/"),
      ...manifests,
    });

    expect(response.headers.get("link")?.split(", ").slice(0, 3)).toEqual([
      "</assets/app.css>; rel=preload; as=style",
      "</assets/home.css>; rel=preload; as=style",
      '</fonts/heading.woff2>; rel=preload; as=font; type="font/woff2"; crossorigin',
    ]);
  });

  it("keeps a Link the route sets through headers() ahead of the preloads", async () => {
    const response = await handlePrachtRequest({
      app: homeApp(),
      registry: {
        ...registry(),
        routeModules: {
          "./routes/home.tsx": async () => ({
            Component: () => h("main", null, "Home"),
            headers: () => ({ link: "<https://cdn.example>; rel=preconnect" }),
          }),
        },
      },
      request: new Request("http://localhost/"),
      ...manifests,
    });

    expect(response.headers.get("link")).toBe(
      ["<https://cdn.example>; rel=preconnect", ...stylesheetLinks].join(", "),
    );
  });

  it("leaves inlined stylesheets out", async () => {
    const response = await handlePrachtRequest({
      app: homeApp(),
      registry: registry(),
      request: new Request("http://localhost/"),
      ...manifests,
      cssContentManifest: { "/assets/app.css": "body{margin:0}" },
    });

    expect(response.headers.get("link")).not.toContain("app.css");
    expect(response.headers.get("link")).toContain("</assets/home.css>; rel=preload; as=style");
  });

  it("hints only stylesheets on a hydration: none page", async () => {
    const response = await handlePrachtRequest({
      app: homeApp({ hydration: "none" }),
      registry: registry(),
      request: new Request("http://localhost/"),
      ...manifests,
    });

    expect(response.headers.get("link")).toBe(stylesheetLinks.join(", "));
  });

  it("is absent from route-state responses", async () => {
    const response = await handlePrachtRequest({
      app: homeApp(),
      registry: registry({ loader: () => ({ ok: true }) }),
      request: new Request("http://localhost/", {
        headers: { "x-pracht-route-state-request": "1" },
      }),
      ...manifests,
    });

    expect(response.headers.get("link")).toBeNull();
  });
});

describe("documentPreloadLinks", () => {
  it("skips URLs that cannot sit in a Link header unchanged and dedupes", () => {
    expect(
      documentPreloadLinks({
        head: {},
        cssUrls: ["/a b.css", "/a>.css", "/ok.css"],
        clientEntryUrl: "/ok.js",
        modulePreloadUrls: ["/ok.js", "/é.js", "/next.js"],
      }),
    ).toEqual([
      "</ok.css>; rel=preload; as=style",
      "</ok.js>; rel=modulepreload",
      "</next.js>; rel=modulepreload",
    ]);
  });

  it(`stops before the joined value passes ${MAX_PRELOAD_LINK_HEADER_LENGTH} characters`, () => {
    const modulePreloadUrls = Array.from(
      { length: 200 },
      (_, index) => `/assets/chunk-${index}.js`,
    );
    const links = documentPreloadLinks({
      head: {},
      cssUrls: ["/assets/app.css"],
      modulePreloadUrls,
    });

    expect(links.join(", ").length).toBeLessThanOrEqual(MAX_PRELOAD_LINK_HEADER_LENGTH);
    expect(links[0]).toBe("</assets/app.css>; rel=preload; as=style");
    // In order, with no gap: the first entry that did not fit ends the list.
    expect(links.slice(1)).toEqual(
      modulePreloadUrls.slice(0, links.length - 1).map((url) => `<${url}>; rel=modulepreload`),
    );
  });
});

describe("onEarlyHints", () => {
  it("fires once, after middleware and before the loader, with the route's assets", async () => {
    const events: string[] = [];
    let hinted: string[] | undefined;
    const response = await handlePrachtRequest({
      app: homeApp({ middleware: ["gate"] }),
      registry: registry({
        gate: () => {
          events.push("middleware");
        },
        loader: () => {
          events.push("loader");
          return {};
        },
      }),
      request: new Request("http://localhost/"),
      onEarlyHints: (links) => {
        events.push("hints");
        hinted = links;
      },
      ...manifests,
    });

    expect(response.status).toBe(200);
    expect(events).toEqual(["middleware", "hints", "loader"]);
    expect(hinted).toEqual(homeLinks);
  });

  it("does not fire when middleware answers the request", async () => {
    let calls = 0;
    const response = await handlePrachtRequest({
      app: homeApp({ middleware: ["gate"] }),
      registry: registry({ gate: () => redirect("/login") }),
      request: new Request("http://localhost/"),
      onEarlyHints: () => {
        calls += 1;
      },
      ...manifests,
    });

    expect(response.status).toBe(302);
    expect(calls).toBe(0);
  });

  it("fires only once when a loader's notFound() renders the not-found page", async () => {
    let calls = 0;
    const app = defineApp({
      shells: { app: "./shells/app.tsx" },
      notFound: "./routes/missing.tsx",
      routes: [route("/", "./routes/home.tsx", { shell: "app" })],
    });
    const response = await handlePrachtRequest({
      app,
      registry: {
        ...registry(),
        routeModules: {
          "./routes/home.tsx": async () => ({
            Component: () => null,
            loader: () => {
              throw notFound();
            },
          }),
          "./routes/missing.tsx": async () => ({ Component: () => h("p", null, "Missing") }),
        },
      },
      request: new Request("http://localhost/"),
      onEarlyHints: () => {
        calls += 1;
      },
      ...manifests,
    });

    expect(response.status).toBe(404);
    expect(await response.text()).toContain("Missing");
    expect(calls).toBe(1);
  });

  it("does not fire for route-state, HEAD, or Markdown-preferring requests", async () => {
    let calls = 0;
    const onEarlyHints = () => {
      calls += 1;
    };
    for (const request of [
      new Request("http://localhost/", { headers: { "x-pracht-route-state-request": "1" } }),
      new Request("http://localhost/", { method: "HEAD" }),
      new Request("http://localhost/", { headers: { accept: "text/markdown" } }),
    ]) {
      await handlePrachtRequest({
        app: homeApp(),
        registry: registry(),
        request,
        onEarlyHints,
        ...manifests,
      });
    }

    expect(calls).toBe(0);
  });

  it("hints only stylesheets on an islands page, before its islands are known", async () => {
    let hinted: string[] | undefined;
    await handlePrachtRequest({
      app: homeApp({ hydration: "islands" }),
      registry: registry(),
      request: new Request("http://localhost/"),
      onEarlyHints: (links) => {
        hinted = links;
      },
      ...manifests,
    });

    expect(hinted).toEqual(stylesheetLinks);
  });

  it("does not fail the page when the callback throws", async () => {
    const response = await handlePrachtRequest({
      app: homeApp(),
      registry: registry(),
      request: new Request("http://localhost/"),
      onEarlyHints: () => {
        throw new Error("socket gone");
      },
      ...manifests,
    });

    expect(response.status).toBe(200);
  });
});
