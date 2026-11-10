import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, expectTypeOf, it } from "vitest";

import {
  arrayOf,
  boolean,
  integer,
  oneOf,
  optional,
  parseInput,
  required,
  string,
  toJsonSchema,
  type InferInput,
} from "../src/mcp-input-schema.ts";
import { createPrachtMcpServer } from "../src/mcp-server.ts";
import { McpToolServer, type JsonRpcMessage } from "../src/mcp-tool-server.ts";

const testDir = dirname(fileURLToPath(import.meta.url));

// The shapes below mirror the dev-mcp tools' argument kinds. Expected issues
// are the ones the server reported when these schemas were zod objects.
const routeShape = {
  cwd: optional(string(), "App root."),
  path: required(string(), "Route path."),
  render: optional(oneOf(["spa", "ssr", "ssg", "isg"]), "Render mode."),
  middleware: optional(arrayOf(string()), "Middleware names."),
  loader: optional(boolean(), "Include a loader."),
  revalidate: optional(integer({ exclusiveMinimum: 0 }), "Seconds."),
};
const searchShape = {
  query: required(string(), "Keywords."),
  limit: optional(integer({ minimum: 1, maximum: 50 }), "Maximum results."),
};
const capabilityShape = {
  name: required(string(), "Capability name."),
  expose: optional(arrayOf(oneOf(["http", "webmcp", "mcp"])), "Transports."),
};

function issues(shape: Parameters<typeof parseInput>[0], input: unknown) {
  const result = parseInput(shape, input);
  if (result.success) throw new Error(`expected ${JSON.stringify(input)} to be rejected`);
  expect(result.message).toBe(JSON.stringify(result.issues, null, 2));
  return result.issues;
}

function connectRaw(server: McpToolServer) {
  const sent: JsonRpcMessage[] = [];
  const transport = {
    onmessage: undefined as ((message: JsonRpcMessage) => void) | undefined,
    async start() {},
    async send(message: JsonRpcMessage) {
      sent.push(message);
    },
    async close() {},
  };
  const ready = server.connect(transport);
  let nextId = 1;
  return async (method: string, params?: unknown) => {
    await ready;
    const id = nextId++;
    transport.onmessage!({ jsonrpc: "2.0", id, method, params });
    for (let tick = 0; tick < 100; tick++) {
      const reply = sent.find((message) => message.id === id);
      if (reply) return reply;
      await new Promise((resolveTick) => setTimeout(resolveTick, 0));
    }
    throw new Error(`no reply to ${method}`);
  };
}

describe("dev-mcp tool input schemas", () => {
  it("advertises the same JSON Schema for every tool as the zod-generated schemas did", async () => {
    const request = connectRaw(createPrachtMcpServer());
    const reply = await request("tools/list");
    const { tools } = reply.result as { tools: { name: string; inputSchema: unknown }[] };
    const schemas = Object.fromEntries(tools.map((tool) => [tool.name, tool.inputSchema]));

    // The fixture is the zod-generated tools/list output. Both sides are
    // serialized so key order is part of the comparison.
    const fixture = JSON.parse(
      readFileSync(resolve(testDir, "fixtures/mcp-tool-input-schemas.json"), "utf-8"),
    );
    expect(JSON.stringify(schemas)).toBe(JSON.stringify(fixture));
  });

  it("emits required keys, descriptions, bounds, and enums", () => {
    expect(toJsonSchema(routeShape)).toEqual({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        cwd: { description: "App root.", type: "string" },
        path: { type: "string", description: "Route path." },
        render: { description: "Render mode.", type: "string", enum: ["spa", "ssr", "ssg", "isg"] },
        middleware: { description: "Middleware names.", type: "array", items: { type: "string" } },
        loader: { description: "Include a loader.", type: "boolean" },
        revalidate: {
          description: "Seconds.",
          type: "integer",
          exclusiveMinimum: 0,
          maximum: Number.MAX_SAFE_INTEGER,
        },
      },
      required: ["path"],
    });
    expect(toJsonSchema({})).toEqual({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {},
    });
  });

  it("accepts valid input and strips keys the shape does not declare", () => {
    const input = JSON.parse(
      '{"path":"/a","render":"isg","revalidate":60,"middleware":["auth"],"loader":false,"extra":1,"__proto__":{"polluted":true}}',
    );
    const result = parseInput(routeShape, input);

    expect(result).toEqual({
      success: true,
      data: { path: "/a", render: "isg", middleware: ["auth"], loader: false, revalidate: 60 },
    });
    expect(Object.keys(result.success ? result.data : {})).not.toContain("extra");
    expect(Object.getPrototypeOf(result.success ? result.data : {})).toBe(Object.prototype);
    expect(parseInput(searchShape, { query: "", limit: 50 }).success).toBe(true);
    expect(parseInput(searchShape, { query: "q", limit: 1 }).success).toBe(true);
    expect(parseInput(capabilityShape, { name: "n", expose: [] }).success).toBe(true);
  });

  it("treats an explicit undefined as an omitted optional key", () => {
    expect(parseInput(searchShape, { query: "q", limit: undefined })).toEqual({
      success: true,
      data: { query: "q" },
    });
  });

  it("rejects arguments that are not an object", () => {
    for (const [input, received] of [
      [[], "array"],
      ["str", "string"],
      [1, "number"],
      [true, "boolean"],
      [null, "null"],
    ] as const) {
      expect(issues(searchShape, input)).toEqual([
        {
          expected: "object",
          code: "invalid_type",
          path: [],
          message: `Invalid input: expected object, received ${received}`,
        },
      ]);
    }
  });

  it("reports missing required keys and wrong types, in shape order", () => {
    expect(issues(routeShape, { cwd: null, loader: "true", extra: 1 })).toEqual([
      {
        expected: "string",
        code: "invalid_type",
        path: ["cwd"],
        message: "Invalid input: expected string, received null",
      },
      {
        expected: "string",
        code: "invalid_type",
        path: ["path"],
        message: "Invalid input: expected string, received undefined",
      },
      {
        expected: "boolean",
        code: "invalid_type",
        path: ["loader"],
        message: "Invalid input: expected boolean, received string",
      },
    ]);
    expect(issues(routeShape, { path: "/a", middleware: "auth" })).toEqual([
      {
        expected: "array",
        code: "invalid_type",
        path: ["middleware"],
        message: "Invalid input: expected array, received string",
      },
    ]);
    expect(issues(routeShape, { path: "/a", middleware: ["a", 2] })).toEqual([
      {
        expected: "string",
        code: "invalid_type",
        path: ["middleware", 1],
        message: "Invalid input: expected string, received number",
      },
    ]);
  });

  it("rejects non-numbers, non-integers, and out-of-range integers", () => {
    expect(issues(searchShape, { query: "q", limit: "5" })).toEqual([
      {
        expected: "number",
        code: "invalid_type",
        path: ["limit"],
        message: "Invalid input: expected number, received string",
      },
    ]);
    expect(issues(searchShape, { query: "q", limit: Number.NaN })).toEqual([
      {
        expected: "number",
        code: "invalid_type",
        received: "NaN",
        path: ["limit"],
        message: "Invalid input: expected number, received NaN",
      },
    ]);
    // A non-integer is reported alone, even when it is also out of range.
    expect(issues(searchShape, { query: "q", limit: 60.5 })).toEqual([
      {
        expected: "int",
        format: "safeint",
        code: "invalid_type",
        path: ["limit"],
        message: "Invalid input: expected int, received number",
      },
    ]);
    expect(issues(searchShape, { query: "q", limit: 0 })).toEqual([
      {
        origin: "number",
        code: "too_small",
        minimum: 1,
        inclusive: true,
        path: ["limit"],
        message: "Too small: expected number to be >=1",
      },
    ]);
    expect(issues(searchShape, { query: "q", limit: 1e20 })).toEqual([
      {
        code: "too_big",
        maximum: Number.MAX_SAFE_INTEGER,
        note: "Integers must be within the safe integer range.",
        origin: "int",
        inclusive: true,
        path: ["limit"],
        message: "Too big: expected int to be <=9007199254740991",
      },
      {
        origin: "number",
        code: "too_big",
        maximum: 50,
        inclusive: true,
        path: ["limit"],
        message: "Too big: expected number to be <=50",
      },
    ]);
    for (const revalidate of [0, -0, -1]) {
      expect(issues(routeShape, { path: "/a", revalidate })).toEqual([
        {
          origin: "number",
          code: "too_small",
          minimum: 0,
          inclusive: false,
          path: ["revalidate"],
          message: "Too small: expected number to be >0",
        },
      ]);
    }
    expect(issues(routeShape, { path: "/a", revalidate: 2 ** 53 })).toEqual([
      {
        code: "too_big",
        maximum: Number.MAX_SAFE_INTEGER,
        note: "Integers must be within the safe integer range.",
        origin: "int",
        inclusive: true,
        path: ["revalidate"],
        message: "Too big: expected int to be <=9007199254740991",
      },
    ]);
  });

  it("rejects values outside an enum, including inside arrays", () => {
    expect(issues(routeShape, { path: "/a", render: 1 })).toEqual([
      {
        code: "invalid_value",
        values: ["spa", "ssr", "ssg", "isg"],
        path: ["render"],
        message: 'Invalid option: expected one of "spa"|"ssr"|"ssg"|"isg"',
      },
    ]);
    expect(issues(capabilityShape, { name: "n", expose: ["http", "bad", null] })).toEqual(
      [1, 2].map((index) => ({
        code: "invalid_value",
        values: ["http", "webmcp", "mcp"],
        path: ["expose", index],
        message: 'Invalid option: expected one of "http"|"webmcp"|"mcp"',
      })),
    );
  });

  it("infers handler input types from the shape", () => {
    expectTypeOf<InferInput<typeof routeShape>>().toEqualTypeOf<{
      path: string;
      cwd?: string;
      render?: "spa" | "ssr" | "ssg" | "isg";
      middleware?: string[];
      loader?: boolean;
      revalidate?: number;
    }>();
    expectTypeOf<InferInput<{}>>().toEqualTypeOf<{}>();
  });
});

describe("McpToolServer tools/call validation", () => {
  it("reports invalid arguments as a tool error and passes stripped input to the handler", async () => {
    const received: unknown[] = [];
    const server = new McpToolServer({ name: "test", version: "0" });
    server.registerTool("search", { description: "search", inputSchema: searchShape }, (input) => {
      expectTypeOf(input).toEqualTypeOf<{ query: string; limit?: number }>();
      received.push(input);
      return { content: [{ type: "text", text: "ok" }] };
    });
    const request = connectRaw(server);

    const invalid = await request("tools/call", {
      name: "search",
      arguments: { query: 1, limit: 0, extra: 1 },
    });
    expect(invalid.result).toEqual({
      content: [
        {
          type: "text",
          text: `Input validation error: Invalid arguments for tool search: ${JSON.stringify(
            [
              {
                expected: "string",
                code: "invalid_type",
                path: ["query"],
                message: "Invalid input: expected string, received number",
              },
              {
                origin: "number",
                code: "too_small",
                minimum: 1,
                inclusive: true,
                path: ["limit"],
                message: "Too small: expected number to be >=1",
              },
            ],
            null,
            2,
          )}`,
        },
      ],
      isError: true,
    });

    const missing = await request("tools/call", { name: "search", arguments: null });
    expect((missing.result as { isError?: boolean }).isError).toBe(true);
    expect(received).toEqual([]);

    const valid = await request("tools/call", {
      name: "search",
      arguments: { query: "q", limit: 3, extra: 1 },
    });
    expect(valid.result).toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(received).toEqual([{ query: "q", limit: 3 }]);
  });
});
