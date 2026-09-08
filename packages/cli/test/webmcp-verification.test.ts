import { describe, expect, it } from "vitest";

import {
  compareWebmcpTools,
  concreteRoutePath,
  webmcpRouteCases,
  type ExpectedWebmcpTool,
} from "../src/webmcp-verification.js";
import {
  findWebmcpBrowser,
  readWebmcpSupport,
  type BrowserToolDescriptor,
} from "../src/webmcp-browser.js";
import type { Page } from "playwright-core";

const expected: ExpectedWebmcpTool = {
  annotations: { readOnlyHint: true },
  description: "Search notes.",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
  name: "notes.search",
  title: "Search notes",
};

const observed: BrowserToolDescriptor = {
  ...expected,
  annotations: { readOnlyHint: true, untrustedContentHint: true },
};

describe("compareWebmcpTools", () => {
  it("compares the graph-owned descriptor fields and ignores additional browser hints", () => {
    expect(compareWebmcpTools([expected], [observed])).toEqual([]);
  });

  it("ignores framework-owned dev page tools without hiding unexpected app tools", () => {
    const devTool = (name: string): BrowserToolDescriptor => ({ ...observed, name });
    expect(
      compareWebmcpTools(
        [expected],
        [observed, devTool("pracht_route"), devTool("pracht_page_tools")],
      ),
    ).toEqual([]);
    expect(compareWebmcpTools([expected], [observed, devTool("notes.unexpected")])).toEqual([
      expect.objectContaining({ kind: "unexpected", tool: "notes.unexpected" }),
    ]);
  });

  it("reports removed or renamed browser registrations as focused drift", () => {
    expect(compareWebmcpTools([expected], [])).toEqual([
      expect.objectContaining({ kind: "missing", tool: "notes.search" }),
    ]);
    expect(compareWebmcpTools([expected], [{ ...observed, name: "notes.find" }])).toEqual([
      expect.objectContaining({ kind: "missing", tool: "notes.search" }),
      expect.objectContaining({ kind: "unexpected", tool: "notes.find" }),
    ]);
  });

  it("names the exact descriptor field that drifted", () => {
    expect(compareWebmcpTools([expected], [{ ...observed, description: "Different." }])).toEqual([
      {
        actual: "Different.",
        expected: "Search notes.",
        field: "description",
        kind: "descriptor",
        tool: "notes.search",
      },
    ]);
  });
});

describe("WebMCP browser compatibility", () => {
  it("reports an unavailable native API with an actionable version requirement", async () => {
    const page = {
      evaluate: async () => ({
        available: false,
        detail:
          "document.modelContext is unavailable. Use Chrome 150+ with the WebMCP testing feature enabled.",
        methods: [],
      }),
    } as unknown as Page;

    await expect(readWebmcpSupport(page)).resolves.toEqual({
      available: false,
      detail: expect.stringContaining("Chrome 150+"),
      methods: [],
    });
  });

  it("rejects a missing explicitly configured browser without downloading one", () => {
    expect(() => findWebmcpBrowser("/definitely/missing/pracht-chrome")).toThrow(
      /does not exist or is not executable/,
    );
  });
});

describe("webmcpRouteCases", () => {
  it("visits active routes then a neutral route to prove cleanup", () => {
    const routes = webmcpRouteCases({
      api: [],
      capabilities: [
        {
          agentPolicy: null,
          description: expected.description,
          effect: "read",
          hasUi: false,
          httpPath: "/api/capabilities/notes/search",
          input: expected.inputSchema,
          middleware: [],
          name: expected.name,
          output: null,
          source: "./notes.ts",
          title: expected.title,
          transports: ["http", "webmcp"],
        },
      ],
      routes: [route("/notes/:collection", ["notes.search"]), route("/about")],
    });

    expect(routes.map(({ route, path }) => ({ route, path }))).toEqual([
      { route: "/notes/:collection", path: "/notes/pracht-webmcp" },
      { route: "/about", path: "/about" },
    ]);
    expect(routes[0].expectedTools).toEqual([expected]);
    expect(routes[1].expectedTools).toEqual([]);
  });

  it("generates deterministic dynamic and catch-all paths", () => {
    expect(concreteRoutePath("/docs/:section/:rest*")).toBe(
      "/docs/pracht-webmcp/pracht-webmcp/path",
    );
    expect(concreteRoutePath("/*")).toBe("/pracht-webmcp/path");
  });
});

function route(path: string, capabilities?: string[]) {
  return {
    ...(capabilities ? { capabilities } : {}),
    file: "./route.tsx",
    hydration: null,
    id: path,
    loaderCache: null,
    loaderFile: null,
    middleware: [],
    path,
    prefetch: null,
    render: "ssr",
    revalidate: null,
    shell: null,
    shellFile: null,
    speculation: null,
    streaming: null,
  };
}
