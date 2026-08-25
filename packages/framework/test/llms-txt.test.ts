import { afterEach, describe, expect, it, vi } from "vitest";

import { defineCapability } from "../../capabilities/src/index.ts";
import { defineApp, resolveApiRoutes, resolveApp, route } from "../src/app.ts";
import { buildLlmsTxt } from "../src/llms-txt.ts";
import type { ModuleRegistry } from "../src/types.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

function createResolvedApp() {
  return resolveApp(
    defineApp({
      routes: [
        route("/", "./routes/home.tsx", { render: "ssg" }),
        route("/about", "./routes/about.tsx", { markdown: true, render: "ssr" }),
        route("/blog/:slug", "./routes/blog.tsx", { render: "ssg" }),
        route("/users/:id", "./routes/user.tsx", { render: "ssr" }),
        route("/settings", "./routes/settings.tsx", { render: "spa" }),
      ],
    }),
  );
}

function createRegistry(): ModuleRegistry {
  return {
    routeModules: {
      "/src/routes/home.tsx": async () => ({ markdown: "# Home" }),
      "/src/routes/about.tsx": async () => ({}),
      "/src/routes/blog.tsx": async () => ({
        // Deliberately unsorted to prove output ordering is stable.
        getStaticPaths: () => [{ slug: "hello-world" }, { slug: "getting-started" }],
      }),
      "/src/routes/user.tsx": async () => ({}),
      "/src/routes/settings.tsx": async () => ({}),
    },
    apiModules: {
      "/src/api/health.ts": async () => ({ GET: () => new Response("ok") }),
      "/src/api/echo.ts": async () => ({
        POST: () => new Response("ok"),
        PUT: () => new Response("ok"),
      }),
    },
  };
}

const apiRoutes = resolveApiRoutes(["/src/api/health.ts", "/src/api/echo.ts"]);

describe("buildLlmsTxt", () => {
  it("renders a deterministic llms.txt from the resolved app graph", async () => {
    const output = await buildLlmsTxt({
      app: createResolvedApp(),
      apiRoutes,
      registry: createRegistry(),
      title: "Pracht Test App",
      description: "A test app.",
    });

    expect(output).toBe(`# Pracht Test App

> A test app.

## Pages

- [/](/): supports \`Accept: text/markdown\`
- [/about](/about): supports \`Accept: text/markdown\`
- [/blog/getting-started](/blog/getting-started)
- [/blog/hello-world](/blog/hello-world)
- [/settings](/settings)

## API

- [/api/echo](/api/echo): POST, PUT
- [/api/health](/api/health): GET
`);
  });

  it("prefixes links with the configured origin", async () => {
    const output = await buildLlmsTxt({
      app: createResolvedApp(),
      apiRoutes,
      registry: createRegistry(),
      title: "Pracht Test App",
      origin: "https://example.com/",
    });

    expect(output).toContain("- [/about](https://example.com/about)");
    expect(output).toContain("- [/api/health](https://example.com/api/health): GET");
    expect(output).not.toContain("example.com//");
  });

  it("serves links under the deploy base", async () => {
    vi.stubEnv("BASE_URL", "/my-project/");
    vi.resetModules();
    const { buildLlmsTxt: build } = await import("../src/llms-txt.ts");

    const output = await build({
      app: createResolvedApp(),
      apiRoutes,
      registry: createRegistry(),
      title: "Pracht Test App",
      origin: "https://example.com",
    });

    // The label stays the route path; the link is the URL as served.
    expect(output).toContain("- [/about](https://example.com/my-project/about)");
  });

  it("omits the description blockquote and excluded sections", async () => {
    const output = await buildLlmsTxt({
      app: createResolvedApp(),
      apiRoutes,
      registry: createRegistry(),
      title: "Pracht Test App",
      include: ["pages"],
    });

    expect(output.startsWith("# Pracht Test App\n\n## Pages\n")).toBe(true);
    expect(output).not.toContain(">");
    expect(output).not.toContain("## API");
  });

  it("skips dynamic routes without enumerable static paths", async () => {
    const output = await buildLlmsTxt({
      app: createResolvedApp(),
      apiRoutes: [],
      registry: {
        // No getStaticPaths on the SSG blog route this time — it has no
        // concrete URLs, so it must not appear.
        routeModules: {
          "/src/routes/blog.tsx": async () => ({}),
        },
      },
      title: "Pracht Test App",
    });

    expect(output).not.toContain("/blog");
    expect(output).not.toContain("/users");
    expect(output).toContain("- [/about](/about)");
  });

  it("renders metadata-declared markdown without a registry or dynamic expansion", async () => {
    const output = await buildLlmsTxt({
      app: createResolvedApp(),
      apiRoutes,
      title: "Pracht Test App",
    });

    expect(output).toContain("- [/](/)\n");
    expect(output).toContain("- [/about](/about): supports `Accept: text/markdown`");
    expect(output).toContain("- [/api/health](/api/health)\n");
  });
});

function createCapability(overrides: Record<string, unknown>) {
  return defineCapability({
    title: "Capability",
    description: "A capability.",
    input: { type: "object", properties: {}, additionalProperties: false },
    output: { type: "object", properties: {} },
    effect: "read",
    async run() {
      return {};
    },
    ...overrides,
  } as Parameters<typeof defineCapability>[0]);
}

function createCapabilityFixtures() {
  const app = resolveApp(
    defineApp({
      capabilities: {
        // Deliberately unsorted to prove name ordering is stable.
        "notes.search": "./capabilities/notes-search.ts",
        "notes.purge": "./capabilities/notes-purge.ts",
        "notes.audit": "./capabilities/notes-audit.ts",
      },
      routes: [route("/", "./routes/home.tsx", { render: "ssg" })],
    }),
  );

  const capabilityModule = (capability: unknown) =>
    (async () => ({ default: capability })) as NonNullable<
      ModuleRegistry["capabilityModules"]
    >[string];

  const registry: ModuleRegistry = {
    routeModules: { "./routes/home.tsx": async () => ({}) },
    capabilityModules: {
      "./capabilities/notes-search.ts": capabilityModule(
        createCapability({
          description: "Find notes.",
          expose: { http: true, webmcp: true },
        }),
      ),
      "./capabilities/notes-purge.ts": capabilityModule(
        createCapability({
          description: "Delete notes.",
          effect: "destructive",
          expose: { http: true },
        }),
      ),
      // Private (no expose) — must not appear: there is no URL to call.
      "./capabilities/notes-audit.ts": capabilityModule(createCapability({})),
    },
  };

  return { app, registry };
}

describe("buildLlmsTxt capabilities", () => {
  it("lists HTTP-exposed capabilities with effect, confirmation, and description", async () => {
    const { app, registry } = createCapabilityFixtures();
    const output = await buildLlmsTxt({ app, registry, title: "Pracht Test App" });

    expect(output).toContain(`## Capabilities

- [notes.purge](/api/capabilities/notes/purge): POST (destructive, requires confirmation) — Delete notes.
- [notes.search](/api/capabilities/notes/search): POST (read) — Find notes.
`);
    expect(output).not.toContain("notes.audit");
  });

  it("prefixes capability endpoints with the configured origin", async () => {
    const { app, registry } = createCapabilityFixtures();
    const output = await buildLlmsTxt({
      app,
      registry,
      title: "Pracht Test App",
      origin: "https://example.com",
    });

    expect(output).toContain("- [notes.search](https://example.com/api/capabilities/notes/search)");
  });

  it("omits the section when excluded or when no registry is available", async () => {
    const { app, registry } = createCapabilityFixtures();

    const excluded = await buildLlmsTxt({
      app,
      registry,
      title: "Pracht Test App",
      include: ["pages", "api"],
    });
    expect(excluded).not.toContain("## Capabilities");

    const withoutRegistry = await buildLlmsTxt({ app, title: "Pracht Test App" });
    expect(withoutRegistry).not.toContain("## Capabilities");
  });

  it("excludes paths matching the configured patterns", async () => {
    const output = await buildLlmsTxt({
      app: createResolvedApp(),
      apiRoutes,
      registry: createRegistry(),
      title: "Pracht Test App",
      // An auth-gated page answers 401 to the agents llms.txt invites, so an
      // app has to be able to keep it out of the file.
      exclude: ["/about", "/blog/**", "/api/echo"],
    });

    expect(output).toContain("- [/](/)");
    expect(output).not.toContain("- [/about](/about)");
    expect(output).not.toContain("/blog/hello-world");
    expect(output).not.toContain("/blog/getting-started");
    expect(output).toContain("- [/api/health](/api/health)");
    expect(output).not.toContain("- [/api/echo](/api/echo)");
  });

  it("rejects an invalid exclude pattern eagerly, whatever the routes are", async () => {
    // `matchRoutePattern` only throws when it evaluates a pattern and
    // `Array.some` short-circuits, so a bad pattern behind a matching one used
    // to stay silent until an unrelated route was added.
    await expect(
      buildLlmsTxt({
        app: createResolvedApp(),
        apiRoutes,
        registry: createRegistry(),
        title: "Pracht Test App",
        exclude: ["/**/secret"],
      }),
    ).rejects.toThrow(/Invalid llmsTxt\.exclude pattern "\/\*\*\/secret"/);

    await expect(
      buildLlmsTxt({
        app: createResolvedApp(),
        apiRoutes,
        registry: createRegistry(),
        title: "Pracht Test App",
        // The first pattern matches everything, so the invalid one would never
        // be evaluated lazily.
        exclude: ["/**", "/**/secret"],
      }),
    ).rejects.toThrow(/Invalid llmsTxt\.exclude pattern/);

    // A `**` that is neither first nor last used to pass validation *and*
    // match nothing — publishing exactly the URLs it was written to hide.
    await expect(
      buildLlmsTxt({ app: createResolvedApp(), title: "T", exclude: ["/a/b/**/c"] }),
    ).rejects.toThrow(/Invalid llmsTxt\.exclude pattern/);

    // An empty entry (a filtered array, a split env var) would drop "/".
    await expect(
      buildLlmsTxt({ app: createResolvedApp(), title: "T", exclude: [""] }),
    ).rejects.toThrow(/empty string/);

    // `defineApp({ constraints })` patterns are absolute; so are these.
    await expect(
      buildLlmsTxt({ app: createResolvedApp(), title: "T", exclude: ["admin/**"] }),
    ).rejects.toThrow(/must ` \+\n?\s*'start with|start with/);
  });

  it("omits the section when the app registers no capabilities", async () => {
    const output = await buildLlmsTxt({
      app: createResolvedApp(),
      apiRoutes,
      registry: createRegistry(),
      title: "Pracht Test App",
    });

    expect(output).not.toContain("## Capabilities");
  });
});

describe("framework-reserved paths", () => {
  it("never lists _pracht endpoints, with or without a user exclude list", async () => {
    const app = resolveApp(
      defineApp({ routes: [route("/", "./routes/home.tsx", { render: "ssg" })] }),
    );
    const apiRoutes = resolveApiRoutes(
      ["/src/api/health.ts", "/src/api/_pracht/image.ts"],
      "/src/api",
    );
    const registry: ModuleRegistry = {
      apiModules: {
        "/src/api/_pracht/image.ts": async () => ({ GET: () => new Response("") }),
        "/src/api/health.ts": async () => ({ GET: () => new Response("") }),
      },
      routeModules: { "/src/routes/home.tsx": async () => ({}) },
    };

    for (const exclude of [undefined, ["/nothing-matches"]]) {
      const output = await buildLlmsTxt({ apiRoutes, app, exclude, registry, title: "App" });
      expect(output).toContain("/api/health");
      // The @pracht/image handler is framework plumbing, not app API surface.
      expect(output).not.toContain("_pracht");
    }
  });
});

describe("buildLlmsTxt page ceilings", () => {
  function appWithPosts(count: number) {
    return {
      app: resolveApp(
        defineApp({ routes: [route("/blog/:slug", "./routes/blog.tsx", { render: "ssg" })] }),
      ),
      registry: {
        routeModules: {
          "/src/routes/blog.tsx": async () => ({
            getStaticPaths: () =>
              Array.from({ length: count }, (_, index) => ({ slug: `post-${index + 1}` })),
          }),
        },
      } as ModuleRegistry,
    };
  }

  // llms.txt is an index, not a sitemap: a 5,000-post blog expanded through
  // getStaticPaths() produced a 5,000-line, 180 KB file — bigger than most
  // agent context budgets, and the 4,990th post says nothing the first ten did
  // not.
  it("caps how many instances one dynamic route contributes", async () => {
    const output = await buildLlmsTxt({ ...appWithPosts(120), title: "Blog" });

    const links = output.split("\n").filter((line) => line.startsWith("- ["));
    expect(links).toHaveLength(50);
  });

  it("says what it left out instead of truncating silently", async () => {
    const output = await buildLlmsTxt({ ...appWithPosts(120), title: "Blog" });

    expect(output).toContain(
      "_Pages lists 50 of 120 prerendered URLs under `/blog/:slug`; 70 are omitted. " +
        "Raise `llmsTxt.maxPagesPerRoute` to include them._",
    );
  });

  // The note sits above `## Pages`, in the free-form block the spec reserves
  // for "markdown sections of any type except headings". Inside an H2 section
  // it made the file unparseable — see the parser-shaped test below.
  it("puts the truncation note above the first heading", async () => {
    const lines = (await buildLlmsTxt({ ...appWithPosts(120), title: "Blog" })).split("\n");

    const noteIndex = lines.findIndex((line) => line.startsWith("_Pages lists"));
    const headingIndex = lines.findIndex((line) => line.startsWith("##"));
    expect(noteIndex).toBeGreaterThan(-1);
    expect(headingIndex).toBeGreaterThan(-1);
    expect(noteIndex).toBeLessThan(headingIndex);
  });

  // The reference parser (AnswerDotAI's `llms_txt`, linked from llmstxt.org)
  // feeds every non-blank line inside an H2 section to a link regex and throws
  // on the first that does not match — prose and list item alike. Anything the
  // generator adds to a section has to stay a link, whatever it is.
  it("emits only links inside H2 sections", async () => {
    const output = await buildLlmsTxt({
      ...appWithPosts(120),
      apiRoutes,
      title: "Blog",
    });

    const sections = output.split(/^##\s*(.*?)$/m).slice(1);
    expect(sections.length).toBeGreaterThan(0);
    for (let index = 1; index < sections.length; index += 2) {
      for (const line of sections[index].split("\n").filter((candidate) => candidate.trim())) {
        expect(line).toMatch(/^-\s*\[[^\]]+\]\([^)]+\)(?::\s*.*)?$/);
      }
    }
  });

  it("honours an explicit ceiling", async () => {
    const output = await buildLlmsTxt({
      ...appWithPosts(10),
      maxPagesPerRoute: 3,
      title: "Blog",
    });

    const links = output.split("\n").filter((line) => line.startsWith("- ["));
    expect(links).toHaveLength(3);
    expect(output).toContain("Pages lists 3 of 10 prerendered URLs under `/blog/:slug`");
  });

  it("lists every instance when the ceiling is 0", async () => {
    const output = await buildLlmsTxt({
      ...appWithPosts(120),
      maxPagesPerRoute: 0,
      title: "Blog",
    });

    const links = output.split("\n").filter((line) => line.startsWith("- ["));
    expect(links).toHaveLength(120);
    expect(output).not.toContain("omitted");
  });

  it("stays quiet when the route fits", async () => {
    const output = await buildLlmsTxt({ ...appWithPosts(3), title: "Blog" });

    expect(output).not.toContain("omitted");
  });

  // Truncating in sorted order picks the wrong pages: `post-1 … post-5000`
  // sorts to post-1, post-10, post-100, post-1000, post-1001 …, so most
  // survivors are a consecutive run from the middle of the archive.
  // getStaticPaths() order is the author's, and for a blog it is newest-first.
  it("keeps the instances getStaticPaths() returned first", async () => {
    const output = await buildLlmsTxt({
      app: resolveApp(
        defineApp({ routes: [route("/blog/:slug", "./routes/blog.tsx", { render: "ssg" })] }),
      ),
      maxPagesPerRoute: 2,
      registry: {
        routeModules: {
          "/src/routes/blog.tsx": async () => ({
            getStaticPaths: () => [
              { slug: "post-2026-08-25" },
              { slug: "post-2026-08-24" },
              { slug: "post-2026-08-23" },
              { slug: "post-2026-01-01" },
            ],
          }),
        },
      } as ModuleRegistry,
      title: "Blog",
    });

    expect(output).toContain("- [/blog/post-2026-08-24](/blog/post-2026-08-24)");
    expect(output).toContain("- [/blog/post-2026-08-25](/blog/post-2026-08-25)");
    expect(output).not.toContain("- [/blog/post-2026-01-01](/blog/post-2026-01-01)");
  });

  // Display order is still lexicographic and independent of getStaticPaths():
  // truncation picks the entries, sorting arranges them.
  it("lists the survivors in path order", async () => {
    const output = await buildLlmsTxt({
      app: resolveApp(
        defineApp({ routes: [route("/blog/:slug", "./routes/blog.tsx", { render: "ssg" })] }),
      ),
      maxPagesPerRoute: 2,
      registry: {
        routeModules: {
          "/src/routes/blog.tsx": async () => ({
            getStaticPaths: () => [{ slug: "zebra" }, { slug: "apple" }, { slug: "mango" }],
          }),
        },
      } as ModuleRegistry,
      title: "Blog",
    });

    const links = output.split("\n").filter((line) => line.startsWith("- ["));
    expect(links).toEqual(["- [/blog/apple](/blog/apple)", "- [/blog/zebra](/blog/zebra)"]);
  });

  // A ceiling that counted URLs the file was never going to list would
  // silently shrink the listing for anyone using `exclude`.
  it("applies the ceiling after exclusions, not before", async () => {
    const output = await buildLlmsTxt({
      ...appWithPosts(10),
      exclude: ["/blog/post-1"],
      maxPagesPerRoute: 3,
      title: "Blog",
    });

    const links = output.split("\n").filter((line) => line.startsWith("- ["));
    expect(links).toHaveLength(3);
    expect(output).not.toContain("- [/blog/post-1](/blog/post-1)");
    expect(output).toContain("Pages lists 3 of 9 prerendered URLs under `/blog/:slug`");
  });

  it("counts each dynamic route separately", async () => {
    const output = await buildLlmsTxt({
      app: resolveApp(
        defineApp({
          routes: [
            route("/blog/:slug", "./routes/blog.tsx", { render: "ssg" }),
            route("/docs/:slug", "./routes/docs.tsx", { render: "ssg" }),
          ],
        }),
      ),
      maxPagesPerRoute: 1,
      registry: {
        routeModules: {
          "/src/routes/blog.tsx": async () => ({
            getStaticPaths: () => [{ slug: "a" }, { slug: "b" }],
          }),
          "/src/routes/docs.tsx": async () => ({
            getStaticPaths: () => [{ slug: "x" }, { slug: "y" }, { slug: "z" }],
          }),
        },
      } as ModuleRegistry,
      title: "Site",
    });

    expect(output).toContain("Pages lists 1 of 2 prerendered URLs under `/blog/:slug`");
    expect(output).toContain("Pages lists 1 of 3 prerendered URLs under `/docs/:slug`");
    // Both notes stay one contiguous block above the heading rather than
    // becoming a list of their own.
    expect(output).toContain(
      "_Pages lists 1 of 2 prerendered URLs under `/blog/:slug`; 1 is omitted. " +
        "Raise `llmsTxt.maxPagesPerRoute` to include it._\n" +
        "_Pages lists 1 of 3 prerendered URLs under `/docs/:slug`; 2 are omitted. " +
        "Raise `llmsTxt.maxPagesPerRoute` to include them._\n",
    );
  });

  // "1 more page ... are not listed" is what a noun-only plural produces.
  it("agrees the verb with a single omitted page", async () => {
    const output = await buildLlmsTxt({
      ...appWithPosts(3),
      maxPagesPerRoute: 2,
      title: "Blog",
    });

    expect(output).toContain(
      "_Pages lists 2 of 3 prerendered URLs under `/blog/:slug`; 1 is omitted. " +
        "Raise `llmsTxt.maxPagesPerRoute` to include it._",
    );
  });

  // A fractional ceiling slipped through `buildLlmsTxt` (only the vite plugin
  // validates it) and reported "7.5 more prerendered pages".
  it("floors a fractional ceiling instead of reporting a fractional count", async () => {
    const output = await buildLlmsTxt({
      ...appWithPosts(10),
      maxPagesPerRoute: 2.5,
      title: "Blog",
    });

    const links = output.split("\n").filter((line) => line.startsWith("- ["));
    expect(links).toHaveLength(2);
    expect(output).toContain("Pages lists 2 of 10 prerendered URLs under `/blog/:slug`");
    expect(output).not.toContain(".5");
  });

  // Deduplicating with `paths.includes(path)` is O(n^2): 50,000 instances took
  // 16 seconds on the machine that wrote this test, against 46 ms for the Map
  // it replaced. The budget is deliberately loose — it only has to fail for a
  // quadratic scan, and it does so by two orders of magnitude.
  it("stays linear in the number of prerendered instances", async () => {
    const started = performance.now();
    const output = await buildLlmsTxt({ ...appWithPosts(50_000), title: "Blog" });
    const elapsed = performance.now() - started;

    expect(output).toContain("Pages lists 50 of 50000 prerendered URLs under `/blog/:slug`");
    expect(elapsed).toBeLessThan(5_000);
  }, 60_000);
});
