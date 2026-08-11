import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { defineApi, json, type ApiHandlerTypes } from "../../framework/src/api-validation.ts";
import type { AppGraphApiRoute } from "../../framework/src/app-graph.ts";
import {
  createOpenApiUiHtml,
  defineOpenApi,
  generateOpenApiDocument,
  getOpenApiDescriptor,
} from "../src/index.ts";

function standardSchema(
  jsonSchema: Record<string, unknown>,
  options: { acceptsUndefined?: boolean } = {},
) {
  return {
    "~standard": {
      version: 1 as const,
      vendor: "pracht-openapi-test",
      validate: (value: unknown) =>
        value === undefined && !options.acceptsUndefined
          ? { issues: [{ message: "Required" }] }
          : { value },
      jsonSchema: {
        input: () => jsonSchema,
        output: () => jsonSchema,
      },
    },
  };
}

function graphRoute(overrides: Partial<AppGraphApiRoute> = {}): AppGraphApiRoute {
  return {
    file: "/src/api/items/[id].ts",
    hasDefaultHandler: false,
    methods: ["POST"],
    path: "/api/items/:id",
    ...overrides,
  };
}

describe("defineOpenApi", () => {
  it("attaches a validated descriptor without replacing the handler", () => {
    const handler = defineApi({ handler: () => ({ ok: true }) });
    const documented = defineOpenApi(handler, {
      summary: "Create an item",
      responses: { 200: { description: "Created" } },
    });

    expect(documented).toBe(handler);
    expectTypeOf<ApiHandlerTypes<typeof documented>>().toEqualTypeOf<
      ApiHandlerTypes<typeof handler>
    >();
    expect(getOpenApiDescriptor(documented)).toEqual({
      summary: "Create an item",
      responses: { 200: { description: "Created" } },
    });
  });

  it("rejects missing response descriptions and invalid response keys", () => {
    const handler = defineApi({ handler: () => ({ ok: true }) });

    expect(() =>
      defineOpenApi(handler, {
        responses: { 200: { description: "" } },
      }),
    ).toThrow("requires a non-empty description");
    expect(() =>
      defineOpenApi(handler, {
        responses: { success: { description: "Nope" } },
      }),
    ).toThrow("must be an HTTP status");
  });
});

describe("generateOpenApiDocument", () => {
  it("preserves document-level servers, tags, components, and security", async () => {
    const result = await generateOpenApiDocument({
      info: { title: "Example", version: "1.0.0" },
      document: {
        servers: [{ url: "https://api.example.com", description: "Production" }],
        tags: [{ name: "health", description: "Service status" }],
        components: {
          securitySchemes: {
            bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
          },
        },
        security: [{ bearerAuth: [] }],
      },
      routes: [],
      loadModule: async () => ({}),
    });

    expect(result.document).toMatchObject({
      servers: [{ url: "https://api.example.com", description: "Production" }],
      tags: [{ name: "health", description: "Service status" }],
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        },
      },
      security: [{ bearerAuth: [] }],
    });
  });

  it("discovers named methods when given live resolved routes", async () => {
    const result = await generateOpenApiDocument({
      info: { title: "Example", version: "1.0.0" },
      routes: [{ file: "/src/api/health.ts", path: "/api/health" }],
      loadModule: async () => ({ GET: () => Response.json({ ok: true }) }),
    });

    expect(result.document.paths["/api/health"]?.get).toMatchObject({
      responses: { default: { description: "Response contract is not documented." } },
    });
    expect(result.warnings.map((warning) => warning.code)).toEqual(["undocumented_response"]);
  });

  it("combines graph paths, Standard JSON Schema requests, and explicit responses", async () => {
    const body = standardSchema({
      type: "object",
      required: ["name"],
      properties: { name: { type: "string" } },
    });
    const params = standardSchema({
      type: "object",
      properties: { id: { type: "string", format: "uuid" } },
    });
    const query = standardSchema({
      type: "object",
      required: ["notify"],
      properties: { notify: { type: "string", enum: ["yes", "no"] } },
    });
    const handler = defineOpenApi(
      defineApi({
        body,
        params,
        query,
        handler: () => json({ id: "42" }, { status: 201 }),
      }),
      {
        operationId: "updateItem",
        summary: "Update an item",
        tags: ["items"],
        responses: {
          201: {
            description: "Item updated",
            body: {
              type: "object",
              required: ["id"],
              properties: { id: { type: "string" } },
            },
          },
        },
      },
    );

    const result = await generateOpenApiDocument({
      info: { title: "Example", version: "1.0.0" },
      routes: [graphRoute()],
      loadModule: async () => ({ POST: handler }),
    });

    expect(result.warnings).toEqual([]);
    expect(result.document.openapi).toBe("3.1.0");
    const operation = result.document.paths["/api/items/{id}"]?.post;
    expect(operation).toMatchObject({
      operationId: "updateItem",
      summary: "Update an item",
      tags: ["items"],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["name"],
            },
          },
        },
      },
      responses: {
        201: {
          description: "Item updated",
          content: {
            "application/json": {
              schema: { type: "object", required: ["id"] },
            },
          },
        },
        400: { description: "Request body could not be parsed." },
        422: { description: "Request validation failed." },
      },
    });
    expect(operation?.parameters).toEqual([
      {
        name: "id",
        in: "path",
        required: true,
        schema: { type: "string", format: "uuid" },
      },
      {
        name: "notify",
        in: "query",
        required: true,
        schema: { type: "string", enum: ["yes", "no"] },
      },
    ]);
  });

  it("keeps request bodies optional when the runtime validator accepts undefined", async () => {
    const body = standardSchema({ type: "object", properties: {} }, { acceptsUndefined: true });
    const handler = defineApi({ body, handler: () => ({ ok: true }) });
    const result = await generateOpenApiDocument({
      info: { title: "Example", version: "1.0.0" },
      routes: [graphRoute()],
      loadModule: async () => ({ POST: handler }),
    });

    expect(result.document.paths["/api/items/{id}"]?.post?.requestBody).toMatchObject({
      required: false,
    });
  });

  it("does not document request bodies or parse errors for bodyless methods", async () => {
    const body = standardSchema({ type: "object", properties: { value: { type: "string" } } });
    const handler = defineOpenApi(defineApi({ body, handler: () => ({ ok: true }) }), {
      responses: { 200: { description: "Success" } },
    });
    const result = await generateOpenApiDocument({
      info: { title: "Example", version: "1.0.0" },
      routes: [graphRoute({ methods: ["GET"] })],
      loadModule: async () => ({ GET: handler }),
    });

    const operation = result.document.paths["/api/items/{id}"]?.get;
    expect(operation?.requestBody).toBeUndefined();
    expect(operation?.responses["400"]).toBeUndefined();
    expect(operation?.responses["422"]).toEqual(
      expect.objectContaining({ description: "Request validation failed." }),
    );
  });

  it("preserves catch-all parameter schema constraints from the runtime wildcard key", async () => {
    const params = standardSchema({
      type: "object",
      properties: { "*": { type: "string", pattern: "^docs/" } },
    });
    const handler = defineOpenApi(defineApi({ params, handler: () => ({ ok: true }) }), {
      responses: { 200: { description: "Success" } },
    });
    const result = await generateOpenApiDocument({
      info: { title: "Example", version: "1.0.0" },
      routes: [
        graphRoute({
          file: "/src/api/files/[...path].ts",
          methods: ["GET"],
          path: "/api/files/*",
        }),
      ],
      loadModule: async () => ({ GET: handler }),
    });

    expect(result.document.paths["/api/files/{path}"]?.get?.parameters).toEqual([
      {
        name: "path",
        in: "path",
        required: true,
        schema: { type: "string", pattern: "^docs/" },
      },
    ]);
  });

  it("emits an honest fallback and warnings for undocumented or unloadable handlers", async () => {
    const onWarning = vi.fn();
    const result = await generateOpenApiDocument({
      info: { title: "Example", version: "1.0.0" },
      routes: [
        graphRoute({
          file: "/src/api/files/[...path].ts",
          hasDefaultHandler: true,
          methods: ["GET"],
          path: "/api/files/*",
        }),
      ],
      loadModule: async () => {
        throw new Error("database unavailable");
      },
      onWarning,
    });

    expect(result.document.paths["/api/files/{path}"]?.get).toMatchObject({
      parameters: [{ name: "path", in: "path", required: true, schema: { type: "string" } }],
      responses: { default: { description: "Response contract is not documented." } },
    });
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "route_module_load_failed",
      "catch_all_path",
      "undocumented_response",
      "default_handler_omitted",
    ]);
    expect(onWarning).toHaveBeenCalledTimes(4);
  });

  it("supports external schema-library resolvers without treating validators as raw schemas", async () => {
    const schema = {
      "~standard": {
        version: 1 as const,
        vendor: "custom",
        validate: (value: unknown) => ({ value }),
      },
    };
    const handler = defineApi({ query: schema, handler: () => ({ ok: true }) });
    const result = await generateOpenApiDocument({
      info: { title: "Example", version: "1.0.0" },
      routes: [graphRoute({ methods: ["GET"] })],
      loadModule: async () => ({ GET: handler }),
      resolveSchema: (value) =>
        value === schema
          ? { type: "object", properties: { search: { type: "string" } } }
          : undefined,
    });

    expect(result.document.paths["/api/items/{id}"]?.get?.parameters).toContainEqual({
      name: "search",
      in: "query",
      required: false,
      schema: { type: "string" },
    });
    expect(result.warnings.map((warning) => warning.code)).toEqual(["undocumented_response"]);
  });
});

describe("createOpenApiUiHtml", () => {
  it("creates a pinned Scalar shell backed by the JSON endpoint", () => {
    const html = createOpenApiUiHtml({
      provider: "scalar",
      documentUrl: "/openapi.json",
      title: "Example API",
    });

    expect(html).toContain("@scalar/api-reference@1.64.0");
    expect(html).toContain('Scalar.createApiReference("#api-reference"');
    expect(html).toContain('{"url":"/openapi.json"}');
  });

  it("creates a privacy-conscious Swagger UI shell and escapes configuration", () => {
    const html = createOpenApiUiHtml({
      provider: "swagger",
      documentUrl: "/openapi.json",
      title: "</title><script>alert(1)</script>",
    });

    expect(html).toContain("swagger-ui-dist@5.32.12");
    expect(html).toContain('"validatorUrl":null');
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;/title&gt;");
  });

  it("rejects cross-origin document URLs", () => {
    expect(() =>
      createOpenApiUiHtml({
        provider: "scalar",
        documentUrl: "https://example.com/openapi.json",
      }),
    ).toThrow(/root-relative/);
  });

  it("rejects backslash URLs that browsers resolve cross-origin", () => {
    expect(() =>
      createOpenApiUiHtml({
        provider: "scalar",
        documentUrl: "/\\evil.example/openapi.json",
      }),
    ).toThrow(/root-relative/);
  });
});
