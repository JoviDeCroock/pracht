import { describe, expect, it } from "vitest";

import { defineCapability } from "../../capabilities/src/index.ts";
import { defineApp, resolveApiRoutes, resolveApp, route } from "../src/app.ts";
import { buildLlmsTxt } from "../src/llms-txt.ts";
import type { ModuleRegistry } from "../src/types.ts";

function createResolvedApp() {
  return resolveApp(
    defineApp({
      routes: [
        route("/", "./routes/home.tsx", { render: "ssg" }),
        route("/about", "./routes/about.tsx", { render: "ssr" }),
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
- [/about](/about)
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

  it("renders without a registry (no markdown notes, no dynamic expansion)", async () => {
    const output = await buildLlmsTxt({
      app: createResolvedApp(),
      apiRoutes,
      title: "Pracht Test App",
    });

    expect(output).toContain("- [/](/)\n");
    expect(output).not.toContain("text/markdown");
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
