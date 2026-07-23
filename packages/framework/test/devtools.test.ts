import { describe, expect, it } from "vitest";

import type { AppGraph } from "../src/app-graph.ts";
import {
  buildAppGraph,
  detectApiExports,
  detectApiMethods,
  serializeAppRoutes,
} from "../src/app-graph.ts";
import { defineApp, resolveApiRoutes, resolveApp, route } from "../src/app.ts";
import { buildDevtoolsHtml, DEVTOOLS_JSON_PATH } from "../src/devtools.ts";

const graphFixture: AppGraph = {
  capabilities: [],
  api: [
    {
      file: "/src/api/health.ts",
      hasDefaultHandler: false,
      methods: ["GET"],
      path: "/api/health",
    },
    {
      file: "/src/api/users/[id].ts",
      hasDefaultHandler: true,
      methods: ["GET", "POST"],
      path: "/api/users/:id",
    },
  ],
  routes: [
    {
      file: "./routes/home.tsx",
      hydration: null,
      id: "home",
      loaderCache: null,
      loaderFile: null,
      middleware: [],
      path: "/",
      prefetch: null,
      render: "ssr",
      revalidate: null,
      shell: "public",
      shellFile: "./shells/public.tsx",
      speculation: null,
    },
    {
      file: "./routes/user.tsx",
      hydration: null,
      id: "user",
      loaderCache: null,
      loaderFile: "./routes/user.data.ts",
      middleware: ["auth", "logger"],
      path: "/users/:id",
      prefetch: "hover",
      render: "spa",
      revalidate: null,
      shell: null,
      shellFile: null,
      speculation: "prefetch",
    },
  ],
};

describe("buildDevtoolsHtml", () => {
  it("renders a self-contained page with the route table", () => {
    const html = buildDevtoolsHtml(graphFixture);

    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("pracht");
    // Page route columns: pattern, render mode, shell, middleware chain, source file.
    expect(html).toContain("/users/:id");
    expect(html).toContain("spa");
    expect(html).toContain("public");
    expect(html).toContain("auth → logger");
    expect(html).toContain("./routes/user.tsx");
    // No Preact — the page must be standalone markup.
    expect(html).not.toContain("preact");
  });

  it("renders the API table and links to the JSON endpoint", () => {
    const html = buildDevtoolsHtml(graphFixture);

    expect(html).toContain("/api/health");
    expect(html).toContain("GET, POST");
    expect(html).toContain("/src/api/users/[id].ts");
    expect(html).toContain(`href="${DEVTOOLS_JSON_PATH}"`);
  });

  it("links static routes but not dynamic patterns", () => {
    const html = buildDevtoolsHtml(graphFixture);

    expect(html).toContain('<a href="/">/</a>');
    expect(html).toContain('<a href="/api/health">/api/health</a>');
    expect(html).not.toContain('href="/users/:id"');
    expect(html).not.toContain('href="/api/users/:id"');
  });

  it("escapes HTML in graph values", () => {
    const html = buildDevtoolsHtml({
      api: [],
      capabilities: [],
      routes: [
        {
          file: "./routes/<script>alert(1)</script>.tsx",
          hydration: null,
          id: "xss",
          loaderCache: null,
          loaderFile: null,
          middleware: [],
          path: "/xss",
          prefetch: null,
          render: null,
          revalidate: null,
          shell: null,
          shellFile: null,
          speculation: null,
        },
      ],
    });

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("renders an empty state when there are no API routes", () => {
    const html = buildDevtoolsHtml({ api: [], capabilities: [], routes: graphFixture.routes });

    expect(html).toContain("No API routes found.");
  });

  it("omits the capabilities section when none are registered", () => {
    const html = buildDevtoolsHtml(graphFixture);

    expect(html).not.toContain("Capabilities");
  });

  it("renders the capabilities table when capabilities are registered", () => {
    const html = buildDevtoolsHtml({
      ...graphFixture,
      capabilities: [
        {
          effect: "read",
          hasUi: false,
          httpPath: "/api/capabilities/notes/search",
          input: { type: "object" },
          middleware: ["auth"],
          name: "notes.search",
          output: { type: "object" },
          source: "./capabilities/notes-search.ts",
          title: "Search notes",
          transports: ["http", "webmcp"],
        },
        {
          effect: "write",
          hasUi: false,
          httpPath: null,
          input: null,
          middleware: [],
          name: "notes.archive",
          output: null,
          source: "./capabilities/notes-archive.ts",
          title: "Archive note",
          transports: [],
        },
      ],
    });

    expect(html).toContain("Capabilities");
    expect(html).toContain("notes.search");
    expect(html).toContain("http, webmcp");
    expect(html).toContain("/api/capabilities/notes/search");
    // Unexposed capabilities are labeled private.
    expect(html).toContain("private");
  });
});

describe("buildAppGraph", () => {
  it("produces the same payload shape as pracht inspect", async () => {
    const app = resolveApp(
      defineApp({
        middleware: { auth: "./middleware/auth.ts" },
        routes: [
          route("/", "./routes/home.tsx", {
            hydration: "islands",
            id: "home",
            loaderCache: 60,
            prefetch: "viewport",
            render: "ssg",
            shell: "public",
            speculation: { eagerness: "eager", mode: "prerender" },
          }),
          route("/users/:id", "./routes/user.tsx", { middleware: ["auth"] }),
        ],
        shells: { public: "./shells/public.tsx" },
      }),
    );

    const graph = await buildAppGraph({
      apiRoutes: resolveApiRoutes(["/src/api/health.ts"]),
      app,
      loadModule: async () => ({ GET() {}, POST() {}, helper: 1 }),
      readSource: () => "",
    });

    expect(graph).toEqual({
      capabilities: [],
      api: [
        {
          file: "/src/api/health.ts",
          hasDefaultHandler: false,
          methods: ["GET", "POST"],
          path: "/api/health",
        },
      ],
      routes: [
        {
          file: "./routes/home.tsx",
          hydration: "islands",
          id: "home",
          loaderCache: 60,
          loaderFile: null,
          middleware: [],
          path: "/",
          prefetch: "viewport",
          render: "ssg",
          revalidate: null,
          shell: "public",
          shellFile: "./shells/public.tsx",
          speculation: { eagerness: "eager", mode: "prerender" },
        },
        {
          file: "./routes/user.tsx",
          hydration: null,
          id: expect.any(String),
          loaderCache: null,
          loaderFile: null,
          middleware: ["auth"],
          path: "/users/:id",
          prefetch: null,
          render: null,
          revalidate: null,
          shell: null,
          shellFile: null,
          speculation: null,
        },
      ],
    });
  });

  it("defaults to an empty API list when no API routes are passed", async () => {
    const app = resolveApp(defineApp({ routes: [route("/", "./routes/home.tsx")] }));

    const graph = await buildAppGraph({
      app,
      loadModule: async () => ({}),
      readSource: () => "",
    });

    expect(graph.api).toEqual([]);
    expect(graph.routes).toHaveLength(1);
  });
});

describe("detectApiMethods", () => {
  it("falls back to source scanning when the module fails to load", async () => {
    const methods = await detectApiMethods("/src/api/broken.ts", {
      loadModule: async () => {
        throw new Error("boom");
      },
      readSource: () => "export async function GET() {}\nexport const DELETE = () => {};",
    });

    expect(methods).toEqual(["GET", "DELETE"]);
  });

  it("returns no methods when the module and source are both unavailable", async () => {
    const methods = await detectApiMethods("/src/api/missing.ts", {
      loadModule: async () => {
        throw new Error("boom");
      },
      readSource: () => {
        throw new Error("missing");
      },
    });

    expect(methods).toEqual([]);
  });
});

describe("detectApiExports", () => {
  it("flags default-export dispatchers on loaded modules", async () => {
    const exports = await detectApiExports("/src/api/webhook.ts", {
      loadModule: async () => ({ default: () => new Response(null) }),
      readSource: () => "",
    });

    expect(exports).toEqual({ hasDefaultHandler: true, methods: [] });
  });

  it("detects default exports alongside method exports in the source fallback", async () => {
    const exports = await detectApiExports("/src/api/broken.ts", {
      loadModule: async () => {
        throw new Error("boom");
      },
      readSource: () =>
        "export async function GET() {}\nexport default async function handler() {}",
    });

    expect(exports).toEqual({ hasDefaultHandler: true, methods: ["GET"] });
  });

  it("reports no default handler when the module and source are both unavailable", async () => {
    const exports = await detectApiExports("/src/api/missing.ts", {
      loadModule: async () => {
        throw new Error("boom");
      },
      readSource: () => {
        throw new Error("missing");
      },
    });

    expect(exports).toEqual({ hasDefaultHandler: false, methods: [] });
  });
});

describe("serializeAppRoutes", () => {
  it("normalizes optional fields to null", () => {
    const [serialized] = serializeAppRoutes([
      {
        file: "./routes/home.tsx",
        middleware: [],
        middlewareFiles: [],
        path: "/",
        segments: [],
      },
    ]);

    expect(serialized).toEqual({
      file: "./routes/home.tsx",
      hydration: null,
      id: "",
      loaderCache: null,
      loaderFile: null,
      middleware: [],
      path: "/",
      prefetch: null,
      render: null,
      revalidate: null,
      shell: null,
      shellFile: null,
      speculation: null,
    });
  });
});
