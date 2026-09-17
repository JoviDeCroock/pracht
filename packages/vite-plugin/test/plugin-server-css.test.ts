import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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
    assets?: string[];
    css?: string[];
    facadeModuleId?: string | null;
    imports?: string[];
    isEntry?: boolean;
    modules?: string[];
  } = {},
): any {
  return {
    type: "chunk",
    code: "",
    fileName,
    facadeModuleId: options.facadeModuleId ?? null,
    imports: options.imports ?? [],
    isEntry: options.isEntry ?? false,
    modules: Object.fromEntries((options.modules ?? []).map((id) => [id, {}])),
    viteMetadata: {
      importedAssets: new Set(options.assets ?? []),
      importedCss: new Set(options.css ?? []),
    },
  };
}

function asset(fileName: string, source: string): any {
  return { type: "asset", fileName, source };
}

/** Drive the plugin's server-build hooks over a bundle and read back the manifest. */
function run(
  bundle: Record<string, any>,
  options: {
    base?: string;
    entry?: { css?: string[]; modules?: string[] };
    imports?: Record<string, string[]>;
    inlineCss?: boolean;
    root?: string;
    warnings?: string[];
  } = {},
): { content: Record<string, string>; manifest: Record<string, string[]> } {
  const plugin = createServerCssAssetsPlugin({ inlineCss: options.inlineCss ?? false }) as any;
  plugin.configResolved({
    base: options.base ?? "/",
    build: { outDir: "dist/server", ssr: true },
    root: options.root ?? ROOT,
  });

  const entry = chunk("server.js", {
    css: options.entry?.css,
    facadeModuleId: "virtual:pracht/server",
    isEntry: true,
    modules: options.entry?.modules,
  });
  entry.code = `return [parse("${ROUTE_CSS_MANIFEST_TOKEN}"), parse("${ROUTE_CSS_CONTENT_TOKEN}")];`;
  const full = { "server.js": entry, ...bundle };

  plugin.generateBundle.call(
    {
      environment: undefined,
      // The module graph a route's own imports are read from.
      getModuleInfo: (id: string) => ({ importedIds: options.imports?.[id] ?? [] }),
      warn: (message: string) => options.warnings?.push(message),
    },
    {},
    full,
  );

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

  it("does not walk into the server entry, which holds every other route's CSS", () => {
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

  it("still links a stylesheet the entry absorbed when the route imports it", () => {
    // What the chunk walk cannot see, the module graph can: the route imports a
    // component whose stylesheet was bundled into the entry, and dropping it
    // shipped the page with class names and no rules.
    const warnings: string[] = [];
    const { manifest } = run(
      {
        "assets/blog.js": chunk("assets/blog.js", {
          css: ["assets/blog-abc.css"],
          facadeModuleId: `${ROOT}/src/routes/blog.tsx`,
          imports: ["server.js"],
        }),
      },
      {
        entry: { css: ["assets/server-abc.css"], modules: [`${ROOT}/src/components/card.css`] },
        imports: {
          [`${ROOT}/src/routes/blog.tsx`]: [`${ROOT}/src/components/Card.tsx`],
          [`${ROOT}/src/components/Card.tsx`]: [`${ROOT}/src/components/card.css`],
        },
        warnings,
      },
    );

    expect(manifest).toEqual({
      "src/routes/blog.tsx": ["/assets/blog-abc.css", "/assets/server-abc.css"],
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("src/components/card.css");
  });

  it("leaves a route alone when nothing of its own was hoisted", () => {
    const warnings: string[] = [];
    const { manifest } = run(
      {
        "assets/blog.js": chunk("assets/blog.js", {
          css: ["assets/blog-abc.css"],
          facadeModuleId: `${ROOT}/src/routes/blog.tsx`,
          imports: ["server.js"],
        }),
      },
      {
        // The entry carries another route's stylesheet; this route imports a
        // module that has none.
        entry: { css: ["assets/server-abc.css"], modules: [`${ROOT}/src/routes/home.css`] },
        imports: { [`${ROOT}/src/routes/blog.tsx`]: [`${ROOT}/src/lib/format.ts`] },
        warnings,
      },
    );

    expect(manifest).toEqual({ "src/routes/blog.tsx": ["/assets/blog-abc.css"] });
    expect(warnings).toEqual([]);
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

describe("stylesheets the client build already published", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
  });

  /** A project whose client build has already written these assets. */
  function projectWithClientOutput(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "pracht-server-css-"));
    roots.push(root);
    mkdirSync(join(root, "dist/client/.vite"), { recursive: true });
    writeFileSync(join(root, "dist/client/.vite/manifest.json"), "{}");
    for (const [name, content] of Object.entries(files)) {
      const path = join(root, "dist/client", name);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, content);
    }
    return root;
  }

  it("serves an identical stylesheet from its published URL instead of a second copy", () => {
    // Islands are chunks in both builds, so a route that renders one resolves
    // the same bytes the islands entry already published. Two URLs for one
    // stylesheet is two downloads for the visitor.
    const root = projectWithClientOutput({ "assets/Counter-abc.css": ".counter{}" });
    const { manifest } = run(
      {
        "assets/home.js": chunk("assets/home.js", {
          css: ["assets/islands/Counter-abc.css"],
          facadeModuleId: `${root}/src/routes/home.tsx`,
        }),
        "assets/islands/Counter-abc.css": asset("assets/islands/Counter-abc.css", ".counter{}"),
      },
      { root },
    );

    expect(manifest).toEqual({ "src/routes/home.tsx": ["/assets/Counter-abc.css"] });
  });

  it("keeps its own copy when the client build published nothing like it", () => {
    const root = projectWithClientOutput({ "assets/other-abc.css": ".other{}" });
    const { manifest } = run(
      {
        "assets/blueprint.js": chunk("assets/blueprint.js", {
          css: ["assets/blueprint-abc.css"],
          facadeModuleId: `${root}/src/routes/blueprint.tsx`,
        }),
        "assets/blueprint-abc.css": asset("assets/blueprint-abc.css", ".hero{}"),
      },
      { root },
    );

    expect(manifest).toEqual({ "src/routes/blueprint.tsx": ["/assets/blueprint-abc.css"] });
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

describe("assets a route imports into its markup", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
  });

  /**
   * Drive both hooks over a bundle whose assets are on disk in `dist/server`,
   * the way Rollup leaves them, and report what reached `dist/client`.
   */
  function publish(
    build: (root: string) => {
      bundle: Record<string, any>;
      client?: Record<string, string>;
      server: Record<string, string>;
    },
  ): { published: string[]; root: string } {
    const root = mkdtempSync(join(tmpdir(), "pracht-server-assets-"));
    roots.push(root);
    const { bundle, client = {}, server } = build(root);

    mkdirSync(join(root, "dist/client/.vite"), { recursive: true });
    writeFileSync(join(root, "dist/client/.vite/manifest.json"), "{}");
    for (const [name, content] of Object.entries(client)) {
      mkdirSync(dirname(join(root, "dist/client", name)), { recursive: true });
      writeFileSync(join(root, "dist/client", name), content);
    }
    for (const [name, content] of Object.entries(server)) {
      mkdirSync(dirname(join(root, "dist/server", name)), { recursive: true });
      writeFileSync(join(root, "dist/server", name), content);
    }

    const plugin = createServerCssAssetsPlugin({ inlineCss: false }) as any;
    plugin.configResolved({ base: "/", build: { outDir: "dist/server", ssr: true }, root });
    const entry = chunk("server.js", { facadeModuleId: "virtual:pracht/server", isEntry: true });
    entry.code = `[parse("${ROUTE_CSS_MANIFEST_TOKEN}"), parse("${ROUTE_CSS_CONTENT_TOKEN}")]`;
    plugin.generateBundle.call(
      { environment: undefined, getModuleInfo: () => ({ importedIds: [] }), warn: () => {} },
      {},
      { "server.js": entry, ...bundle },
    );
    plugin.writeBundle.call({});

    const assetsDir = join(root, "dist/client/assets");
    const published = existsSync(assetsDir)
      ? readdirSync(assetsDir, { recursive: true })
          .map((name) => String(name).replace(/\\/g, "/"))
          .sort()
      : [];
    return { published, root };
  }

  it("copies the file behind an asset import out of the server build", () => {
    // `import dots from "./dots.svg"` in a `hydration: "none"` route: the module
    // holding the URL never reaches the client build, so without this the page
    // renders an `<img src>` pointing at a file only `dist/server` has.
    const { published } = publish((root) => ({
      bundle: {
        "assets/static-page.js": chunk("assets/static-page.js", {
          facadeModuleId: `${root}/src/routes/static-page.tsx`,
          imports: ["assets/dots.js"],
        }),
        "assets/dots.js": chunk("assets/dots.js", { assets: ["assets/dots-abc.svg"] }),
        "assets/dots-abc.svg": asset("assets/dots-abc.svg", "<svg/>"),
      },
      server: { "assets/dots-abc.svg": "<svg/>" },
    }));

    expect(published).toEqual(["dots-abc.svg"]);
  });

  it("leaves a file the client build already published where it is", () => {
    const { published, root } = publish((base) => ({
      bundle: {
        "assets/home.js": chunk("assets/home.js", {
          assets: ["assets/hero-abc.jpg"],
          facadeModuleId: `${base}/src/routes/home.tsx`,
        }),
        "assets/hero-abc.jpg": asset("assets/hero-abc.jpg", "jpeg"),
      },
      client: { "assets/hero-abc.jpg": "client copy" },
      server: { "assets/hero-abc.jpg": "server copy" },
    }));

    expect(published).toEqual(["hero-abc.jpg"]);
    expect(readFileSync(join(root, "dist/client/assets/hero-abc.jpg"), "utf-8")).toBe(
      "client copy",
    );
  });

  it("does not publish what only the server entry imports", () => {
    // The entry holds every API handler, so an asset reachable only through it
    // is not something a page renders a URL to.
    const { published } = publish((root) => ({
      bundle: {
        "assets/static-page.js": chunk("assets/static-page.js", {
          facadeModuleId: `${root}/src/routes/static-page.tsx`,
          imports: ["server.js"],
        }),
        "assets/private-abc.pem": asset("assets/private-abc.pem", "key"),
      },
      server: { "assets/private-abc.pem": "key" },
    }));

    expect(published).toEqual([]);
  });
});
