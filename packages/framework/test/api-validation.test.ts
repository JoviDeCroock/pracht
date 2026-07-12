import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, it } from "vitest";

import {
  apiValidationErrorResponse,
  defineApi,
  defineApp,
  formDataToRecord,
  handlePrachtRequest,
  isApiValidationErrorBody,
  json,
  resolveApiRoutes,
  route,
  searchParamsToRecord,
  validateStandardSchema,
  type ApiRouteArgs,
} from "../src/index.ts";

type ObjectSchemaOutput<TShape extends Record<string, "string" | "number">> = {
  [TKey in keyof TShape]: TShape[TKey] extends "string" ? string : number;
};

function objectSchema<TShape extends Record<string, "string" | "number">>(
  shape: TShape,
  { async = false } = {},
): StandardSchemaV1<Record<string, unknown>, ObjectSchemaOutput<TShape>> {
  return {
    "~standard": {
      version: 1,
      vendor: "pracht-test",
      validate(value) {
        const result = (() => {
          if (typeof value !== "object" || value === null) {
            return { issues: [{ message: "Expected an object" }] };
          }

          const issues = Object.entries(shape).flatMap(([key, type]) =>
            typeof (value as Record<string, unknown>)[key] === type
              ? []
              : [{ message: `Expected ${type}`, path: [key] }],
          );
          return issues.length > 0 ? { issues } : { value: value as ObjectSchemaOutput<TShape> };
        })();

        return async ? Promise.resolve(result) : result;
      },
    },
  };
}

// Explicit context generic: the repo's example apps augment
// Register["context"], which would otherwise leak into the default here.
function apiArgs(request: Request): ApiRouteArgs<Record<string, never>> {
  const url = new URL(request.url);
  return {
    request,
    params: {},
    context: {},
    signal: new AbortController().signal,
    url,
    route: { path: url.pathname, file: "/src/api/test.ts", segments: [] },
  };
}

describe("defineApi", () => {
  it("validates a JSON body and passes the parsed value to the handler", async () => {
    const handler = defineApi({
      body: objectSchema({ name: "string" }),
      handler: ({ body }) => ({ created: body.name }),
    });

    const response = await handler(
      apiArgs(
        new Request("http://localhost/api/items", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "pracht" }),
        }),
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ created: "pracht" });
  });

  it("parses request media types case-insensitively", async () => {
    const handler = defineApi({
      body: objectSchema({ name: "string" }),
      handler: ({ body }) => ({ created: body.name }),
    });

    const response = await handler(
      apiArgs(
        new Request("http://localhost/api/items", {
          method: "POST",
          headers: { "content-type": "Application/JSON" },
          body: JSON.stringify({ name: "pracht" }),
        }),
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ created: "pracht" });
  });

  it("answers schema failures with the standardized 422 issue body", async () => {
    const handler = defineApi({
      body: objectSchema({ name: "string" }),
      handler: () => ({ ok: true }),
    });

    const response = await handler(
      apiArgs(
        new Request("http://localhost/api/items", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: 42 }),
        }),
      ),
    );

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(isApiValidationErrorBody(body)).toBe(true);
    expect(body).toEqual({
      error: "validation",
      issues: [{ in: "body", message: "Expected string", path: ["name"] }],
    });
  });

  it("answers malformed JSON with a 400 validation body", async () => {
    const handler = defineApi({
      body: objectSchema({ name: "string" }),
      handler: () => ({ ok: true }),
    });

    const response = await handler(
      apiArgs(
        new Request("http://localhost/api/items", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{nope",
        }),
      ),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "validation",
      issues: [{ in: "body", message: "Malformed JSON body" }],
    });
  });

  it("parses form submissions into a record for the body schema", async () => {
    const handler = defineApi({
      body: objectSchema({ name: "string" }),
      handler: ({ body }) => ({ name: body.name }),
    });

    const formData = new FormData();
    formData.set("name", "pracht");
    const response = await handler(
      apiArgs(new Request("http://localhost/api/items", { method: "POST", body: formData })),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ name: "pracht" });
  });

  it("validates the query string, collecting repeated keys into arrays", async () => {
    let seenQuery: unknown;
    const handler = defineApi({
      query: objectSchema({ q: "string" }),
      handler: ({ query }) => {
        seenQuery = query;
        return { ok: true };
      },
    });

    const response = await handler(
      apiArgs(new Request("http://localhost/api/search?q=hi&tag=a&tag=b")),
    );

    expect(response.status).toBe(200);
    expect(seenQuery).toEqual({ q: "hi", tag: ["a", "b"] });

    const invalid = await handler(apiArgs(new Request("http://localhost/api/search")));
    expect(invalid.status).toBe(422);
    await expect(invalid.json()).resolves.toEqual({
      error: "validation",
      issues: [{ in: "query", message: "Expected string", path: ["q"] }],
    });
  });

  it("validates params and reports every failing source together", async () => {
    const handler = defineApi({
      query: objectSchema({ q: "string" }),
      params: objectSchema({ id: "string" }),
      handler: () => ({ ok: true }),
    });

    const args = apiArgs(new Request("http://localhost/api/items/42"));
    const response = await handler({ ...args, params: {} });

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.issues).toEqual([
      { in: "query", message: "Expected string", path: ["q"] },
      { in: "params", message: "Expected string", path: ["id"] },
    ]);
  });

  it("supports async standard schemas", async () => {
    const handler = defineApi({
      body: objectSchema({ name: "string" }, { async: true }),
      handler: ({ body }) => ({ name: body.name }),
    });

    const response = await handler(
      apiArgs(
        new Request("http://localhost/api/items", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "async" }),
        }),
      ),
    );

    await expect(response.json()).resolves.toEqual({ name: "async" });
  });

  it("passes handler Response returns through unchanged", async () => {
    const handler = defineApi({
      handler: () => new Response("made it", { status: 201 }),
    });

    const response = await handler(apiArgs(new Request("http://localhost/api/raw")));
    expect(response.status).toBe(201);
    await expect(response.text()).resolves.toBe("made it");
  });

  it("rejects JSON values whose runtime representation would change type", async () => {
    const dateHandler = defineApi({
      // Simulate an untyped consumer bypassing the compile-time JSON check.
      handler: (() => new Date("2026-07-12T00:00:00.000Z")) as () => never,
    });
    await expect(dateHandler(apiArgs(new Request("http://localhost/api/date")))).rejects.toThrow(
      "non-plain object at $",
    );

    const numberHandler = defineApi({ handler: () => Number.NaN });
    await expect(
      numberHandler(apiArgs(new Request("http://localhost/api/number"))),
    ).rejects.toThrow("non-finite number at $");

    const array = ["value"] as string[] & { metadata?: string };
    array.metadata = "not serialized";
    const arrayHandler = defineApi({ handler: (() => array) as () => never });
    await expect(arrayHandler(apiArgs(new Request("http://localhost/api/array")))).rejects.toThrow(
      "extra array data at $.metadata",
    );
  });

  it("exposes the schemas on the handler for tooling", () => {
    const body = objectSchema({ name: "string" });
    const handler = defineApi({ body, handler: () => ({ ok: true }) });
    expect(handler.schemas.body).toBe(body);
    expect(handler.schemas.query).toBeUndefined();
  });

  it("runs inside the runtime's API dispatch", async () => {
    const app = defineApp({
      routes: [route("/", "./routes/home.tsx")],
    });

    const response = await handlePrachtRequest({
      apiRoutes: resolveApiRoutes(["/src/api/items.ts"]),
      app,
      registry: {
        apiModules: {
          "/src/api/items.ts": async () => ({
            POST: defineApi({
              body: objectSchema({ name: "string" }),
              handler: ({ body }) => ({ created: body.name }),
            }),
          }),
        },
      },
      request: new Request("http://localhost/api/items", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost" },
        body: JSON.stringify({ name: 7 }),
      }),
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: "validation",
      issues: [{ in: "body", message: "Expected string", path: ["name"] }],
    });
  });
});

describe("json", () => {
  it("builds a JSON response with the given status and headers", async () => {
    const response = json({ created: "pracht" }, { status: 201, headers: { "x-request": "1" } });

    expect(response.status).toBe(201);
    expect(response.headers.get("x-request")).toBe("1");
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({ created: "pracht" });
  });

  it("rejects values that would change type over the wire", () => {
    expect(() => json({ createdAt: new Date() } as never)).toThrow(TypeError);
  });

  it("passes through defineApi with its status intact", async () => {
    const handler = defineApi({
      handler: () => json({ created: true }, { status: 201 }),
    });

    const response = await handler(apiArgs(new Request("http://localhost/api/items")));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ created: true });
  });
});

describe("record helpers", () => {
  it("searchParamsToRecord keeps single values flat and repeats as arrays", () => {
    const record = searchParamsToRecord(new URLSearchParams("a=1&b=2&b=3"));
    expect(record).toEqual({ a: "1", b: ["2", "3"] });
  });

  it("formDataToRecord keeps single values flat and repeats as arrays", () => {
    const formData = new FormData();
    formData.append("a", "1");
    formData.append("b", "2");
    formData.append("b", "3");
    expect(formDataToRecord(formData)).toEqual({ a: "1", b: ["2", "3"] });
  });

  it("preserves special field names without changing the record prototype", () => {
    const query = searchParamsToRecord(new URLSearchParams("__proto__=query&constructor=value"));
    const formData = new FormData();
    formData.set("__proto__", "form");

    const form = formDataToRecord(formData);

    expect(Object.getPrototypeOf(query)).toBeNull();
    expect(query["__proto__"]).toBe("query");
    expect(query.constructor).toBe("value");
    expect(Object.getPrototypeOf(form)).toBeNull();
    expect(form["__proto__"]).toBe("form");
  });

  it("rejects malformed validation issue bodies", () => {
    expect(isApiValidationErrorBody({ error: "validation", issues: [null] })).toBe(false);
    expect(
      isApiValidationErrorBody({
        error: "validation",
        issues: [{ in: "other", message: "Invalid" }],
      }),
    ).toBe(false);
    expect(
      isApiValidationErrorBody({
        error: "validation",
        issues: [{ in: "body", message: "Invalid", path: [null] }],
      }),
    ).toBe(false);
  });

  it("normalizes schema paths so validation issues survive JSON", async () => {
    const schema: StandardSchemaV1 = {
      "~standard": {
        version: 1,
        vendor: "pracht-test",
        validate: () => ({
          issues: [{ message: "Invalid", path: [Symbol("field"), Number.POSITIVE_INFINITY] }],
        }),
      },
    };

    await expect(validateStandardSchema(schema, null, "body")).resolves.toEqual({
      issues: [
        {
          in: "body",
          message: "Invalid",
          path: ["Symbol(field)", "Infinity"],
        },
      ],
    });

    const response = apiValidationErrorResponse([
      { in: "params", message: "Invalid", path: [Number.NEGATIVE_INFINITY] },
    ]);
    await expect(response.json()).resolves.toEqual({
      error: "validation",
      issues: [{ in: "params", message: "Invalid", path: ["-Infinity"] }],
    });
  });
});
