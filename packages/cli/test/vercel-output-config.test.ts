import { describe, expect, it } from "vitest";

import { createVercelOutputConfig } from "../src/vercel-output-config.ts";

describe("createVercelOutputConfig", () => {
  it("routes markdown-preferring requests for markdown routes to the function", () => {
    const config = createVercelOutputConfig({
      headersManifest: {},
      isgRoutes: [],
      markdownRoutes: ["/guide"],
      staticRoutes: ["/", "/guide", "/pricing"],
    });

    const guideRoutes = config.routes.filter((entry) => entry.src === "^/guide/?$");
    // The Accept-conditional entry has to come first, or the static rewrite
    // claims the request and the function never runs.
    expect(guideRoutes).toEqual([
      {
        dest: "/render",
        has: [
          {
            type: "header",
            key: "accept",
            value: ".*[tT][eE][xX][tT]/[mM][aA][rR][kK][dD][oO][wW][nN].*",
          },
        ],
        src: "^/guide/?$",
      },
      { dest: "/guide/index.html", src: "^/guide/?$" },
    ]);

    // Routes without a `markdown` export keep their static fast path whatever
    // the client sends.
    for (const src of ["^/$", "^/pricing/?$"]) {
      expect(config.routes.filter((entry) => entry.src === src)).toHaveLength(1);
    }
  });

  it("emits markdown routing only for routes that export markdown", () => {
    const routesJson = (markdownRoutes: string[]) =>
      JSON.stringify(
        createVercelOutputConfig({
          headersManifest: {},
          isgRoutes: [],
          markdownRoutes,
          staticRoutes: ["/", "/guide"],
        }),
      );

    // Paired: the negative assertion alone would pass with the feature deleted.
    expect(routesJson(["/guide"])).toContain("mM][aA][rR][kK]");
    expect(routesJson([])).not.toContain("mM][aA][rR][kK]");
  });

  it("routes ISG markdown routes to the render function, not the prerender function", () => {
    const config = createVercelOutputConfig({
      functionName: "ssr-handler",
      headersManifest: {},
      isgRoutes: ["/pricing"],
      markdownRoutes: ["/pricing"],
      staticRoutes: ["/"],
    });

    // The prerender function re-renders on a sanitized `Accept: text/html` to
    // keep its shared cache entry correct, so it can only ever produce HTML —
    // markdown has to reach the render function instead.
    expect(config.routes.filter((entry) => entry.src === "^/pricing/?$")).toEqual([
      {
        dest: "/ssr-handler",
        has: [
          {
            type: "header",
            key: "accept",
            value: ".*[tT][eE][xX][tT]/[mM][aA][rR][kK][dD][oO][wW][nN].*",
          },
        ],
        src: "^/pricing/?$",
      },
      { dest: "/pricing", src: "^/pricing/?$" },
    ]);
  });
});
