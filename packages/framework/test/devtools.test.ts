import { describe, expect, it } from "vitest";

import type { AppGraph } from "../src/app-graph.ts";
import { buildAppGraph, detectApiMethods, serializeAppRoutes } from "../src/app-graph.ts";
import { defineApp, resolveApiRoutes, resolveApp, route } from "../src/app.ts";
import { buildDevtoolsHtml, DEVTOOLS_JSON_PATH } from "../src/devtools.ts";

const graphFixture: AppGraph = {
  capabilities: [],
  api: [
    {
      file: "/src/api/health.ts",
      methods: ["GET"],
      path: "/api/health",
    },
    {
      file: "/src/api/users/[id].ts",
      methods: ["GET", "POST"],
      path: "/api/users/:id",
    },
  ],
  routes: [
    {
      file: "./routes/home.tsx",
      id: "home",
      loaderFile: null,
      middleware: [],
      path: "/",
      render: "ssr",
      revalidate: null,
      shell: "public",
      shellFile: "./shells/public.tsx",
    },
    {
      file: "./routes/user.tsx",
      id: "user",
      loaderFile: "./routes/user.data.ts",
      middleware: ["auth", "logger"],
      path: "/users/:id",
      render: "spa",
      revalidate: null,
      shell: null,
      shellFile: null,
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
          id: "xss",
          loaderFile: null,
          middleware: [],
          path: "/xss",
          render: null,
          revalidate: null,
          shell: null,
          shellFile: null,
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
          middleware: ["auth"],
          name: "notes.search",
          source: "./capabilities/notes-search.ts",
          title: "Search notes",
          transports: ["http", "webmcp"],
        },
        {
          effect: "write",
          hasUi: false,
          httpPath: null,
          middleware: [],
          name: "notes.archive",
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
          route("/", "./routes/home.tsx", { id: "home", render: "ssg", shell: "public" }),
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
          methods: ["GET", "POST"],
          path: "/api/health",
        },
      ],
      routes: [
        {
          file: "./routes/home.tsx",
          id: "home",
          loaderFile: null,
          middleware: [],
          path: "/",
          render: "ssg",
          revalidate: null,
          shell: "public",
          shellFile: "./shells/public.tsx",
        },
        {
          file: "./routes/user.tsx",
          id: expect.any(String),
          loaderFile: null,
          middleware: ["auth"],
          path: "/users/:id",
          render: null,
          revalidate: null,
          shell: null,
          shellFile: null,
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
      id: "",
      loaderFile: null,
      middleware: [],
      path: "/",
      render: null,
      revalidate: null,
      shell: null,
      shellFile: null,
    });
  });
});
