import { describe, expect, it } from "vitest";

import type { AppGraph } from "../src/app-graph.ts";
import {
  buildAppGraph,
  detectApiExports,
  detectApiExportsStatic,
  detectApiMethods,
  serializeApiRoutes,
  serializeAppRoutes,
  serializeCapabilities,
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

  it("keeps navigable links under the Vite deploy base", () => {
    const html = buildDevtoolsHtml(graphFixture, { base: "/app/" });

    expect(html).toContain('<a href="/app/">/</a>');
    expect(html).toContain('<a href="/app/api/health">/api/health</a>');
    expect(html).toContain(`href="/app${DEVTOOLS_JSON_PATH}"`);
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

  it("lists the app notFound page alongside the routes", () => {
    const html = buildDevtoolsHtml({
      ...graphFixture,
      notFound: {
        file: "./routes/not-found.tsx",
        hydration: null,
        id: "__pracht_not_found__",
        loaderCache: null,
        loaderFile: null,
        middleware: [],
        path: "(not found)",
        prefetch: null,
        render: "ssr",
        revalidate: null,
        shell: "public",
        shellFile: "./shells/public.tsx",
        speculation: null,
      },
    });

    expect(html).toContain("(not found)");
    expect(html).toContain("./routes/not-found.tsx");
    // Not a URL — never rendered as a link.
    expect(html).not.toContain('href="(not found)"');
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
          agentPolicy: null,
          description: "Find notes whose title or body matches the query.",
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
          agentPolicy: null,
          description: null,
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

// ---------------------------------------------------------------------------
// Agent traffic panel
// ---------------------------------------------------------------------------

const capabilityGraphFixture: AppGraph = {
  ...graphFixture,
  capabilities: [
    {
      agentPolicy: null,
      description: null,
      effect: "read",
      hasUi: false,
      httpPath: "/api/capabilities/notes/search",
      input: null,
      middleware: [],
      name: "notes.search",
      output: null,
      source: "./capabilities/notes-search.ts",
      title: null,
      transports: ["http"],
    },
  ],
};

describe("buildDevtoolsHtml — agent traffic", () => {
  it("omits the Agents section for an app with no capabilities", () => {
    const html = buildDevtoolsHtml(graphFixture, {
      agentTraffic: { limit: 200, recorded: 0, events: [] },
    });

    expect(html).not.toContain("<h2>Agents");
  });

  it("shows an empty state once capabilities exist but nothing has been called", () => {
    const html = buildDevtoolsHtml(capabilityGraphFixture, {
      agentTraffic: { limit: 200, recorded: 0, events: [] },
    });

    expect(html).toContain("<h2>Agents</h2>");
    expect(html).toContain("No capability dispatches recorded yet.");
  });

  it("renders one row per dispatch with transport, agent, outcome and duration", () => {
    const html = buildDevtoolsHtml(capabilityGraphFixture, {
      agentTraffic: {
        limit: 200,
        recorded: 2,
        events: [
          {
            at: Date.UTC(2026, 7, 26, 9, 30, 15, 250),
            capability: "notes.search",
            effect: "read",
            transport: "mcp",
            via: null,
            outcome: "ok",
            status: 200,
            durationMs: 4.2,
            agent: { agentDomain: "agent.example", keyId: "kid-1" },
          },
          {
            at: Date.UTC(2026, 7, 26, 9, 30, 14, 0),
            capability: "notes.purge",
            effect: "destructive",
            transport: "server",
            via: "http",
            outcome: "confirmation_required",
            status: 409,
            durationMs: 11,
            agent: null,
          },
        ],
      },
    });

    expect(html).toContain("<h2>Agents — 2 dispatches</h2>");
    expect(html).toContain("09:30:15.250");
    expect(html).toContain("agent.example");
    expect(html).toContain(`<td class="ok">ok (200)</td>`);
    expect(html).toContain("4ms");
    expect(html).toContain("11ms");
    // Nested composition names the transport it was composed under.
    expect(html).toContain("http → server");
    expect(html).toContain(`<td class="err">confirmation_required (409)</td>`);
    // No verified identity renders as the em dash the other tables use.
    expect(html).toContain("<td>destructive</td>\n        <td>—</td>");
  });

  it("says how many older events the ring buffer dropped", () => {
    const html = buildDevtoolsHtml(capabilityGraphFixture, {
      agentTraffic: {
        limit: 1,
        recorded: 5,
        events: [
          {
            at: Date.UTC(2026, 7, 26, 9, 30, 15, 250),
            capability: "notes.search",
            effect: "read",
            transport: "http",
            via: null,
            outcome: "ok",
            status: 200,
            durationMs: 0.4,
            agent: null,
          },
        ],
      },
    });

    expect(html).toContain("<h2>Agents — 5 dispatches · 4 older dropped</h2>");
    // Sub-millisecond in-process dispatch must not round to a misleading 0ms.
    expect(html).toContain("&lt;1ms");
  });

  it("escapes capability and agent values", () => {
    const html = buildDevtoolsHtml(capabilityGraphFixture, {
      agentTraffic: {
        limit: 200,
        recorded: 1,
        events: [
          {
            at: Date.UTC(2026, 7, 26, 9, 30, 15, 250),
            capability: "<script>alert(1)</script>",
            effect: "read",
            transport: "http",
            via: null,
            outcome: "ok",
            status: 200,
            durationMs: 1,
            agent: { agentDomain: "<img onerror=x>", keyId: "kid" },
          },
        ],
      },
    });

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img onerror=x&gt;");
  });

  it("renders unchanged when no traffic is supplied at all", () => {
    expect(buildDevtoolsHtml(capabilityGraphFixture)).toContain("<h2>Agents</h2>");
    expect(buildDevtoolsHtml(capabilityGraphFixture)).toContain(
      "No capability dispatches recorded yet.",
    );
  });
});

describe("buildAppGraph", () => {
  it("fails a strict API graph read with the route, file, and original module error", async () => {
    await expect(
      serializeApiRoutes(
        resolveApiRoutes(["/src/api/broken.ts"]),
        {
          loadModule: async () => {
            throw new Error("API initialization exploded");
          },
          readSource: () => "export function GET() {}",
        },
        { strict: true },
      ),
    ).rejects.toThrow(
      'Failed to load API route "/api/broken" from "/src/api/broken.ts" while resolving the app graph: API initialization exploded',
    );
  });

  it("fails a strict capability graph read with the original module error", async () => {
    await expect(
      serializeCapabilities(
        { "edge.runtime": "./capabilities/edge-runtime.ts" },
        {
          loadModule: async () => {
            throw new Error('Pracht graph inspection has no Node stub for "cloudflare:future".');
          },
          readSource: () => "",
        },
        { strict: true },
      ),
    ).rejects.toThrow(
      'Failed to load capability "edge.runtime" from "./capabilities/edge-runtime.ts" while resolving the app graph: Pracht graph inspection has no Node stub for "cloudflare:future".',
    );
  });

  it("produces the same payload shape as pracht inspect", async () => {
    const app = resolveApp(
      defineApp({
        agents: { mcp: { path: "/agents/mcp" } },
        middleware: { auth: "./middleware/auth.ts" },
        routes: [
          route("/", "./routes/home.tsx", {
            hydration: "islands",
            id: "home",
            loaderCache: 60,
            markdown: true,
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
      mcpEndpoint: "/agents/mcp",
      notFound: null,
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
          markdown: true,
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
    expect(graph.mcpEndpoint).toBeNull();
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

  it("does not treat a regex default export as a callable source fallback", async () => {
    const exports = await detectApiExports("/src/api/regex.ts", {
      loadModule: async () => {
        throw new Error("boom");
      },
      readSource: () => "export default /export const GET/;",
    });

    expect(exports).toEqual({ hasDefaultHandler: false, methods: [] });
  });

  it("does not treat nested method declarations as source-fallback exports", async () => {
    const exports = await detectApiExports("/src/api/nested-method.ts", {
      loadModule: async () => {
        throw new Error("boom");
      },
      readSource: () =>
        "namespace Internal { export function GET() {} }\nexport function PATCH() {}",
    });

    expect(exports).toEqual({ hasDefaultHandler: false, methods: ["PATCH"] });
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

describe("detectApiExportsStatic", () => {
  it("resolves named, aliased, and star re-exports without assuming a default is callable", async () => {
    const sources: Record<string, string> = {
      "/src/api/index.ts": [
        'export { GET, handler as POST } from "./read.ts";',
        'export * from "./nested.ts";',
        "export { fallback as default };",
      ].join("\n"),
      "/src/api/nested.ts": [
        "// export function DELETE() {}",
        "export const PATCH = () => new Response(null);",
        'export * from "./index.ts";',
      ].join("\n"),
    };

    const result = await detectApiExportsStatic("/src/api/index.ts", {
      readSource: (file) => sources[file],
      resolveModule: (specifier) =>
        specifier === "./nested.ts" ? "/src/api/nested.ts" : "/src/api/index.ts",
    });

    expect(result).toEqual({
      hasDefaultHandler: false,
      methods: ["GET", "POST", "PATCH"],
    });
  });

  it("recognizes default handlers that are provably callable from local syntax", async () => {
    const sources: Record<string, string> = {
      "/src/api/direct.ts": "export default async function handler() {}",
      "/src/api/local.ts": "function fallback() {}\nexport { fallback as default };",
      "/src/api/identifier.ts": "function handler() {}\nexport default handler;",
      "/src/api/identifier-asi.ts":
        "const initialized = true\nfunction handler() {}\nexport default handler;",
      "/src/api/re-export.ts": 'export { handler as default } from "./handler.ts";',
    };

    const readSource = (file: string) => sources[file];
    await expect(detectApiExportsStatic("/src/api/direct.ts", { readSource })).resolves.toEqual({
      hasDefaultHandler: true,
      methods: [],
    });
    await expect(detectApiExportsStatic("/src/api/local.ts", { readSource })).resolves.toEqual({
      hasDefaultHandler: true,
      methods: [],
    });
    await expect(detectApiExportsStatic("/src/api/identifier.ts", { readSource })).resolves.toEqual(
      {
        hasDefaultHandler: true,
        methods: [],
      },
    );
    await expect(
      detectApiExportsStatic("/src/api/identifier-asi.ts", { readSource }),
    ).resolves.toEqual({
      hasDefaultHandler: true,
      methods: [],
    });
    await expect(detectApiExportsStatic("/src/api/re-export.ts", { readSource })).resolves.toEqual({
      hasDefaultHandler: false,
      methods: [],
    });
  });

  it("does not treat nested declarations as callable module bindings", async () => {
    const sources = [
      [
        "namespace Internal { export function handler() {} }",
        "const handler = 1;",
        "export { handler as default };",
      ].join("\n"),
      [
        "function outer() { function handler() {} }",
        "const handler = 1;",
        "export default handler;",
      ].join("\n"),
      [
        "if (true) { function handler() {} }",
        "const handler = 1;",
        "export { handler as default };",
      ].join("\n"),
      [
        "const wrappers = [function handler() {}];",
        "const handler = 1;",
        "export default handler;",
      ].join("\n"),
      [
        "const wrapper = () => function handler() {};",
        "const handler = 1;",
        "export { handler as default };",
      ].join("\n"),
      [
        "const wrapper = (function handler() {});",
        "const handler = 1;",
        "export default handler;",
      ].join("\n"),
      [
        "for (const handler = () => {}; false; ) {}",
        "const handler = 1;",
        "export default handler;",
      ].join("\n"),
      [
        "for (let handler = function () {}; false; ) {}",
        "const handler = 1;",
        "export { handler as default };",
      ].join("\n"),
    ];

    for (const source of sources) {
      await expect(
        detectApiExportsStatic("/src/api/non-callable.ts", { readSource: () => source }),
      ).resolves.toEqual({ hasDefaultHandler: false, methods: [] });
    }
  });

  it("does not report HTTP methods exported only inside nested scopes", async () => {
    const result = await detectApiExportsStatic("/src/api/nested-method.ts", {
      readSource: () =>
        [
          "namespace Internal { export function GET() {} }",
          "if (true) { export const POST = () => new Response(null); }",
          "const expressions = [function GET() {}];",
          "const returned = () => function POST() {};",
          "const invoked = (function DELETE() {});",
          "for (const GET = () => new Response(null); false; ) {}",
          "for (let POST = function () {}; false; ) {}",
          "export const PATCH = () => new Response(null);",
        ].join("\n"),
    });

    expect(result).toEqual({ hasDefaultHandler: false, methods: ["PATCH"] });
  });

  it("does not parse exports inside a regex literal after export default", async () => {
    for (const source of [
      "export default /export const GET/;",
      "export default /export { POST }/;",
    ]) {
      await expect(
        detectApiExportsStatic("/src/api/regex.ts", { readSource: () => source }),
      ).resolves.toEqual({ hasDefaultHandler: false, methods: [] });
    }
  });

  it("does not mistake commented exports for handlers", async () => {
    const result = await detectApiExportsStatic("/src/api/comments.ts", {
      readSource: () =>
        [
          "/* export default function nope() {} */",
          "// export const GET = nope",
          'const docs = "export const POST = nope";',
          "const example = `export default function nope() {}`;",
        ].join("\n"),
    });

    expect(result).toEqual({ hasDefaultHandler: false, methods: [] });
  });

  it("does not mistake type-only exports or regex contents for handlers", async () => {
    const result = await detectApiExportsStatic("/src/api/static-only.ts", {
      readSource: () =>
        [
          "type GET = () => Response;",
          "type Fallback = () => Response;",
          "export { type GET, type Fallback as default };",
          "const namedExample = /export { POST }/;",
          "const defaultExample = /export default function handler() {}/;",
          "function docs() { return /export { DELETE }/; }",
          'if (Math.random()) /export { OPTIONS }/.test("");',
          "const ratio = 4 / 2; export const PATCH = () => new Response(null);",
        ].join("\n"),
    });

    expect(result).toEqual({ hasDefaultHandler: false, methods: ["PATCH"] });
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
