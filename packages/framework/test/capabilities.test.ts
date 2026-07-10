import { describe, expect, it } from "vitest";

import { defineCapability } from "../../capabilities/src/index.ts";
import { defineApp, handlePrachtRequest, invokeCapability, route } from "../src/index.ts";
import {
  capabilityHttpPath,
  matchCapabilityRoute,
  resolveAppCapabilities,
} from "../src/runtime-capabilities.ts";
import type { LoaderArgs, ModuleRegistry } from "../src/types.ts";

type CapabilityDefinition = Parameters<typeof defineCapability>[0];

function createSearchCapability(overrides: Record<string, unknown> = {}) {
  return defineCapability({
    title: "Search notes",
    description: "Find notes.",
    input: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      properties: { notes: { type: "array", items: { type: "string" } } },
      required: ["notes"],
    },
    effect: "read",
    expose: { http: true },
    async run({ input }) {
      const typed = input as { query: string; limit: number };
      return { notes: [`${typed.query}:${typed.limit}`] };
    },
    ...overrides,
  } as CapabilityDefinition);
}

function createApp(capabilityModule: unknown, options: Record<string, unknown> = {}) {
  const app = defineApp({
    middleware: {
      deny: "./middleware/deny.ts",
      passthrough: "./middleware/passthrough.ts",
    },
    capabilities: {
      "notes.search": "./capabilities/notes-search.ts",
    },
    routes: [route("/", "./routes/home.tsx")],
    ...options,
  });

  const registry: ModuleRegistry = {
    routeModules: {
      "./routes/home.tsx": async () => ({ Component: () => null }),
    },
    middlewareModules: {
      "./middleware/deny.ts": async () => ({
        middleware: async () => new Response("denied", { status: 401 }),
      }),
      "./middleware/passthrough.ts": async () => ({
        middleware: async (
          args: { context: Record<string, unknown> },
          next: () => Promise<Response>,
        ) => {
          args.context.fromMiddleware = true;
          return next();
        },
      }),
    },
    capabilityModules: {
      "./capabilities/notes-search.ts": (async () => ({
        default: capabilityModule,
      })) as NonNullable<ModuleRegistry["capabilityModules"]>[string],
    },
  };

  return { app, registry };
}

function postCapability(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("capabilityHttpPath", () => {
  it("maps dots to slashes under the capabilities prefix", () => {
    expect(capabilityHttpPath("notes.search")).toBe("/api/capabilities/notes/search");
    expect(capabilityHttpPath("archive")).toBe("/api/capabilities/archive");
    expect(capabilityHttpPath("projects.tasks.create")).toBe(
      "/api/capabilities/projects/tasks/create",
    );
  });
});

describe("resolveAppCapabilities", () => {
  it("resolves registered capabilities with default HTTP paths", async () => {
    const { app, registry } = createApp(createSearchCapability());
    const resolved = await resolveAppCapabilities(app, registry);

    expect(resolved).toHaveLength(1);
    expect(resolved[0].name).toBe("notes.search");
    expect(resolved[0].httpPath).toBe("/api/capabilities/notes/search");
    expect(matchCapabilityRoute(resolved, "/api/capabilities/notes/search")?.name).toBe(
      "notes.search",
    );
    expect(matchCapabilityRoute(resolved, "/api/capabilities/notes/other")).toBeUndefined();
  });

  it("honors custom HTTP paths", async () => {
    const { app, registry } = createApp(
      createSearchCapability({ expose: { http: { path: "/api/find-notes" } } }),
    );
    const resolved = await resolveAppCapabilities(app, registry);
    expect(resolved[0].httpPath).toBe("/api/find-notes");
  });

  it("keeps unexposed capabilities private (no HTTP path)", async () => {
    const { app, registry } = createApp(createSearchCapability({ expose: undefined }));
    const resolved = await resolveAppCapabilities(app, registry);
    expect(resolved[0].httpPath).toBeNull();
  });

  it("rejects unknown middleware names with a helpful error", async () => {
    const { app, registry } = createApp(createSearchCapability({ middleware: ["authz"] }));
    await expect(resolveAppCapabilities(app, registry)).rejects.toThrow(/Unknown middleware/);
  });

  it("rejects modules that do not export a capability", async () => {
    const { app, registry } = createApp({ not: "a capability" });
    await expect(resolveAppCapabilities(app, registry)).rejects.toThrow(
      /must default-export the result of defineCapability/,
    );
  });

  it("rejects hand-rolled destructive exposed capability objects", async () => {
    const capability = { ...createSearchCapability(), effect: "destructive" as const };
    const { app, registry } = createApp(capability);
    await expect(resolveAppCapabilities(app, registry)).rejects.toThrow(
      /destructive capabilities cannot be exposed yet/,
    );
  });
});

describe("capability HTTP projection", () => {
  it("serves an exposed capability at the default path", async () => {
    const { app, registry } = createApp(createSearchCapability());

    const response = await handlePrachtRequest({
      app,
      registry,
      request: postCapability("/api/capabilities/notes/search", { query: "hello" }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    // Input defaults were applied before run().
    expect(await response.json()).toEqual({ ok: true, data: { notes: ["hello:10"] } });
  });

  it("returns 400 with path-scoped issues for invalid input", async () => {
    const { app, registry } = createApp(createSearchCapability());

    const response = await handlePrachtRequest({
      app,
      registry,
      request: postCapability("/api/capabilities/notes/search", { query: "", limit: 99 }),
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("invalid_input");
    expect(body.error.issues).toEqual([
      { path: "/query", message: "must be at least 1 character(s) long" },
      { path: "/limit", message: "must be <= 50" },
    ]);
  });

  it("returns 400 for malformed JSON bodies", async () => {
    const { app, registry } = createApp(createSearchCapability());

    const response = await handlePrachtRequest({
      app,
      registry,
      request: new Request("http://localhost/api/capabilities/notes/search", {
        method: "POST",
        body: "{nope",
      }),
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_json");
  });

  it("returns 405 for non-POST methods on a capability path", async () => {
    const { app, registry } = createApp(createSearchCapability());

    const response = await handlePrachtRequest({
      app,
      registry,
      request: new Request("http://localhost/api/capabilities/notes/search"),
    });

    expect(response.status).toBe(405);
    expect((await response.json()).error.code).toBe("method_not_allowed");
  });

  it("returns a typed 404 for unknown paths under the capability prefix", async () => {
    const { app, registry } = createApp(createSearchCapability());

    const response = await handlePrachtRequest({
      app,
      registry,
      request: postCapability("/api/capabilities/notes/missing", {}),
    });

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("unknown_capability");
  });

  it("does not serve private capabilities over HTTP", async () => {
    const { app, registry } = createApp(createSearchCapability({ expose: undefined }));

    const response = await handlePrachtRequest({
      app,
      registry,
      request: postCapability("/api/capabilities/notes/search", { query: "hello" }),
    });

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("unknown_capability");
  });

  it("lets middleware deny the request as an envelope with the original status", async () => {
    const { app, registry } = createApp(createSearchCapability({ middleware: ["deny"] }));

    const response = await handlePrachtRequest({
      app,
      registry,
      request: postCapability("/api/capabilities/notes/search", { query: "hello" }),
    });

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("unauthorized");
  });

  it("runs middleware before the handler with a shared mutable context", async () => {
    const capability = createSearchCapability({
      middleware: ["passthrough"],
      async run({
        input,
        context,
      }: {
        input: { query: string };
        context: Record<string, unknown>;
      }) {
        return { notes: [String(context.fromMiddleware), input.query] };
      },
    });
    const { app, registry } = createApp(capability);

    const response = await handlePrachtRequest({
      app,
      registry,
      request: postCapability("/api/capabilities/notes/search", { query: "hi" }),
    });

    expect(await response.json()).toEqual({ ok: true, data: { notes: ["true", "hi"] } });
  });

  it("treats invalid output as a redacted server error, never returning it raw", async () => {
    const capability = createSearchCapability({
      async run() {
        return { secret: "internal-value" };
      },
    });
    const { app, registry } = createApp(capability);

    const response = await handlePrachtRequest({
      app,
      registry,
      request: postCapability("/api/capabilities/notes/search", { query: "hi" }),
    });

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.code).toBe("invalid_output");
    // Redacted by default: no issues, no schema details, no raw output.
    expect(body.error.message).toBe("Capability failed.");
    expect(body.error.issues).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("internal-value");
  });

  it("exposes output validation details only with debugErrors", async () => {
    const capability = createSearchCapability({
      async run() {
        return {};
      },
    });
    const { app, registry } = createApp(capability);

    const response = await handlePrachtRequest({
      app,
      registry,
      debugErrors: true,
      request: postCapability("/api/capabilities/notes/search", { query: "hi" }),
    });

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.message).toContain("does not match its output schema");
    expect(body.error.issues).toEqual([{ path: "/notes", message: "is required" }]);
  });

  it("redacts thrown run() errors unless debugErrors is set", async () => {
    const capability = createSearchCapability({
      async run() {
        throw new Error("database exploded");
      },
    });
    const { app, registry } = createApp(capability);

    const redacted = await handlePrachtRequest({
      app,
      registry,
      request: postCapability("/api/capabilities/notes/search", { query: "hi" }),
    });
    expect(redacted.status).toBe(500);
    expect(JSON.stringify(await redacted.json())).not.toContain("database exploded");

    const debug = await handlePrachtRequest({
      app,
      registry,
      debugErrors: true,
      request: postCapability("/api/capabilities/notes/search", { query: "hi" }),
    });
    expect((await debug.json()).error.message).toContain("database exploded");
  });

  it("blocks cross-origin capability POSTs by default", async () => {
    const { app, registry } = createApp(createSearchCapability());

    const response = await handlePrachtRequest({
      app,
      registry,
      request: new Request("http://localhost/api/capabilities/notes/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://evil.example",
        },
        body: JSON.stringify({ query: "hello" }),
      }),
    });

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("cross_origin_blocked");
  });

  it("gives explicit API route files precedence over capability paths", async () => {
    const { app, registry } = createApp(
      createSearchCapability({ expose: { http: { path: "/api/health" } } }),
    );
    registry.apiModules = {
      "/src/api/health.ts": async () => ({
        POST: async () => Response.json({ from: "api-route" }),
      }),
    };

    const { resolveApiRoutes } = await import("../src/index.ts");
    const response = await handlePrachtRequest({
      app,
      registry,
      apiRoutes: resolveApiRoutes(["/src/api/health.ts"]),
      request: postCapability("/api/health", { query: "hello" }),
    });

    expect(await response.json()).toEqual({ from: "api-route" });
  });
});

describe("invokeCapability", () => {
  it("invokes a capability directly from a loader through the same pipeline", async () => {
    const { app, registry } = createApp(createSearchCapability(), {
      routes: [route("/notes", "./routes/notes.tsx", { id: "notes" })],
    });
    registry.routeModules = {
      "./routes/notes.tsx": async () => ({
        loader: async ({ request, context, signal }: LoaderArgs) =>
          invokeCapability("notes.search", { query: "from-loader" }, { request, context, signal }),
        Component: () => null,
      }),
    };

    const response = await handlePrachtRequest({
      app,
      registry,
      request: new Request("http://localhost/notes?_data=1"),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: { ok: true, data: { notes: ["from-loader:10"] } },
    });
  });

  it("works for private capabilities and returns validation envelopes", async () => {
    const { app, registry } = createApp(createSearchCapability({ expose: undefined }), {
      routes: [route("/notes", "./routes/notes.tsx", { id: "notes" })],
    });
    registry.routeModules = {
      "./routes/notes.tsx": async () => ({
        loader: async ({ request, context, signal }: LoaderArgs) =>
          invokeCapability("notes.search", {}, { request, context, signal }),
        Component: () => null,
      }),
    };

    const response = await handlePrachtRequest({
      app,
      registry,
      request: new Request("http://localhost/notes?_data=1"),
    });

    const body = await response.json();
    expect(body.data.ok).toBe(false);
    expect(body.data.error.code).toBe("invalid_input");
    expect(body.data.error.issues).toEqual([{ path: "/query", message: "is required" }]);
  });

  it("returns an unknown_capability envelope with suggestions", async () => {
    const { app, registry } = createApp(createSearchCapability(), {
      routes: [route("/notes", "./routes/notes.tsx", { id: "notes" })],
    });
    registry.routeModules = {
      "./routes/notes.tsx": async () => ({
        loader: async ({ request, context, signal }: LoaderArgs) =>
          invokeCapability("notes.serach", { query: "x" }, { request, context, signal }),
        Component: () => null,
      }),
    };

    const response = await handlePrachtRequest({
      app,
      registry,
      request: new Request("http://localhost/notes?_data=1"),
    });

    const body = await response.json();
    expect(body.data.ok).toBe(false);
    expect(body.data.error.code).toBe("unknown_capability");
    expect(body.data.error.message).toContain("notes.search");
  });
});
