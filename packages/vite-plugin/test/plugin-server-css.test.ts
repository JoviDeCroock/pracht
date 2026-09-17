import { describe, expect, it } from "vitest";

import {
  collectReferencedAssets,
  createServerCssAssetsPlugin,
  escapeForStringLiteral,
  ROUTE_CSS_CONTENT_TOKEN,
  ROUTE_CSS_MANIFEST_TOKEN,
} from "../src/plugin-server-css.ts";

const ROOT = "/project";

function chunk(
  fileName: string,
  options: {
    css?: string[];
    facadeModuleId?: string | null;
    imports?: string[];
    isEntry?: boolean;
  } = {},
): any {
  return {
    type: "chunk",
    code: "",
    fileName,
    facadeModuleId: options.facadeModuleId ?? null,
    imports: options.imports ?? [],
    isEntry: options.isEntry ?? false,
    viteMetadata: { importedCss: new Set(options.css ?? []) },
  };
}

function asset(fileName: string, source: string): any {
  return { type: "asset", fileName, source };
}

/** Drive the plugin's server-build hooks over a bundle and read back the manifest. */
function run(
  bundle: Record<string, any>,
  options: { base?: string; inlineCss?: boolean } = {},
): { content: Record<string, string>; manifest: Record<string, string[]> } {
  const plugin = createServerCssAssetsPlugin({ inlineCss: options.inlineCss ?? false }) as any;
  plugin.configResolved({
    base: options.base ?? "/",
    build: { outDir: "dist/server", ssr: true },
    root: ROOT,
  });

  const entry = chunk("server.js", { facadeModuleId: "virtual:pracht/server", isEntry: true });
  entry.code = `return [parse("${ROUTE_CSS_MANIFEST_TOKEN}"), parse("${ROUTE_CSS_CONTENT_TOKEN}")];`;
  const full = { "server.js": entry, ...bundle };

  plugin.generateBundle.call({ environment: undefined }, {}, full);

  // Evaluate the patched chunk the way the runtime does: JavaScript unescapes
  // the literal, then the payload is parsed as JSON. Anything that survives
  // only under a stricter reader would be a false pass.
  const [manifest, content] = new Function("parse", entry.code)(JSON.parse);
  return { manifest, content };
}

describe("server-build CSS for routes outside the client bundle", () => {
  it("maps a route chunk to its own stylesheet", () => {
    const { manifest } = run({
      "assets/blueprint.js": chunk("assets/blueprint.js", {
        css: ["assets/blueprint-abc.css"],
        facadeModuleId: `${ROOT}/src/routes/blueprint.tsx`,
      }),
      "assets/blueprint-abc.css": asset("assets/blueprint-abc.css", ".hero{}"),
    });

    expect(manifest).toEqual({
      "src/routes/blueprint.tsx": ["/assets/blueprint-abc.css"],
    });
  });

  it("follows imports, so a styled component the route renders is included", () => {
    const { manifest } = run({
      "assets/post.js": chunk("assets/post.js", {
        facadeModuleId: `${ROOT}/src/routes/posts/hydration.tsx`,
        imports: ["assets/Dates.js"],
      }),
      "assets/Dates.js": chunk("assets/Dates.js", { css: ["assets/Dates-xyz.css"] }),
    });

    expect(manifest).toEqual({
      "src/routes/posts/hydration.tsx": ["/assets/Dates-xyz.css"],
    });
  });

  it("stops at the server entry, which holds every other route's CSS", () => {
    // A route reaches the entry because an island it renders was hoisted there.
    // Walking in would hand it the whole app's stylesheets.
    const { manifest } = run({
      "assets/blog.js": chunk("assets/blog.js", {
        css: ["assets/blog-abc.css"],
        facadeModuleId: `${ROOT}/src/routes/blog.tsx`,
        imports: ["server.js"],
      }),
    });

    expect(manifest).toEqual({ "src/routes/blog.tsx": ["/assets/blog-abc.css"] });
  });

  it("ignores dependencies and virtual modules", () => {
    const { manifest } = run({
      "assets/vendor.js": chunk("assets/vendor.js", {
        css: ["assets/vendor.css"],
        facadeModuleId: `${ROOT}/node_modules/some-ui/index.js`,
      }),
      "assets/virtual.js": chunk("assets/virtual.js", {
        css: ["assets/virtual.css"],
        facadeModuleId: "\0virtual:something",
      }),
    });

    expect(manifest).toEqual({});
  });

  it("prefixes asset URLs with the deploy base", () => {
    const { manifest } = run(
      {
        "assets/home.js": chunk("assets/home.js", {
          css: ["assets/home-abc.css"],
          facadeModuleId: `${ROOT}/src/routes/home.tsx`,
        }),
      },
      { base: "/app/" },
    );

    expect(manifest).toEqual({ "src/routes/home.tsx": ["/app/assets/home-abc.css"] });
  });

  it("carries stylesheet contents only when inlining is enabled", () => {
    const bundle = {
      "assets/home.js": chunk("assets/home.js", {
        css: ["assets/home-abc.css"],
        facadeModuleId: `${ROOT}/src/routes/home.tsx`,
      }),
      "assets/home-abc.css": asset("assets/home-abc.css", ".hero{color:red}"),
    };

    expect(run(bundle).content).toEqual({});
    expect(run(bundle, { inlineCss: true }).content).toEqual({
      "/assets/home-abc.css": ".hero{color:red}",
    });
  });

  it("leaves a client bundle alone", () => {
    const plugin = createServerCssAssetsPlugin({ inlineCss: false }) as any;
    plugin.configResolved({ base: "/", build: { outDir: "dist/client", ssr: false }, root: ROOT });
    const entry = chunk("client.js", { isEntry: true });
    entry.code = `parse("${ROUTE_CSS_MANIFEST_TOKEN}")`;

    plugin.generateBundle.call({ environment: undefined }, {}, { "client.js": entry });

    expect(entry.code).toContain(ROUTE_CSS_MANIFEST_TOKEN);
  });

  it("asks Vite to emit the server build's assets", () => {
    const plugin = createServerCssAssetsPlugin({ inlineCss: false }) as any;
    expect(plugin.config()).toEqual({ build: { ssrEmitAssets: true } });
  });

  it("escapes payloads so they read back under either quote style", () => {
    const value = { "a'b": ['"c"', "back\\slash", "new\nline"] };
    const escaped = escapeForStringLiteral(JSON.stringify(value));

    // A bare single quote would terminate a single-quoted literal.
    expect(escaped).not.toMatch(/(^|[^\\])'/);
    for (const quote of ['"', "'"]) {
      expect(new Function(`return ${quote}${escaped}${quote}`)()).toBe(JSON.stringify(value));
    }
  });
});

describe("assets a route stylesheet references", () => {
  const bundle = {
    "assets/page.css": asset(
      "assets/page.css",
      [
        ".hero{background-image:url(/assets/hero-abc.png)}",
        '.icon{background:url("/assets/icon-abc.svg")}',
        "@font-face{src:url('/assets/inter-abc.woff2') format('woff2')}",
        ".inline{background:url(data:image/svg+xml,%3csvg/%3e)}",
        ".remote{background:url(https://cdn.example.com/logo.png)}",
        ".public{background:url(/logo.png)}",
        ".masked{mask:url(#fade)}",
      ].join("\n"),
    ),
    "assets/hero-abc.png": asset("assets/hero-abc.png", "png"),
    "assets/icon-abc.svg": asset("assets/icon-abc.svg", "<svg/>"),
    "assets/inter-abc.woff2": asset("assets/inter-abc.woff2", "woff2"),
  };

  it("collects what the build emitted and nothing else", () => {
    expect(collectReferencedAssets(bundle, ["assets/page.css"], "/").sort()).toEqual([
      "assets/hero-abc.png",
      "assets/icon-abc.svg",
      "assets/inter-abc.woff2",
    ]);
  });

  it("follows a relative reference and an @import chain", () => {
    const nested = {
      "assets/page.css": asset("assets/page.css", '@import "./shared-abc.css";'),
      "assets/shared-abc.css": asset(
        "assets/shared-abc.css",
        ".logo{background:url(../media/logo-abc.png)}",
      ),
      "media/logo-abc.png": asset("media/logo-abc.png", "png"),
    };

    expect(collectReferencedAssets(nested, ["assets/page.css"], "/").sort()).toEqual([
      "assets/shared-abc.css",
      "media/logo-abc.png",
    ]);
  });

  it("strips a deploy base, including a CDN one", () => {
    const based = {
      "assets/page.css": asset(
        "assets/page.css",
        [
          ".a{background:url(https://cdn.example.com/assets/hero-abc.png)}",
          // Root-relative under a CDN base is someone else's URL, not ours.
          ".b{background:url(/assets/icon-abc.svg)}",
        ].join("\n"),
      ),
      "assets/hero-abc.png": asset("assets/hero-abc.png", "png"),
      "assets/icon-abc.svg": asset("assets/icon-abc.svg", "<svg/>"),
    };

    expect(collectReferencedAssets(based, ["assets/page.css"], "https://cdn.example.com/")).toEqual(
      ["assets/hero-abc.png"],
    );
  });

  it("terminates on a cycle", () => {
    const cyclic = {
      "assets/a.css": asset("assets/a.css", '@import "./b.css";'),
      "assets/b.css": asset("assets/b.css", '@import "./a.css";'),
    };

    expect(collectReferencedAssets(cyclic, ["assets/a.css"], "/")).toEqual(["assets/b.css"]);
  });
});
