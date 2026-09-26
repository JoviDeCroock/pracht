import type { StandardSchemaV1 } from "@standard-schema/spec";
import { h } from "preact";
import type { ComponentChildren } from "preact";
import { describe, expect, it } from "vitest";

import { parseRouteSearch } from "../src/api-validation.ts";
import {
  defineApp,
  handlePrachtRequest,
  prerenderApp,
  route,
  useSearch,
  type ErrorBoundaryProps,
  type HeadArgs,
  type LoaderArgs,
  type SearchArgs,
} from "../src/index.ts";

interface CatalogSearch {
  page: number;
  q?: string;
  tag: string[];
}

/**
 * A hand-rolled Standard Schema with the shape a validator's
 * `z.object({ page: z.coerce.number().int().min(1).default(1), ... })` has:
 * coerces strings, applies defaults, and rejects out-of-range values.
 */
function catalogSchema({ async = false } = {}): StandardSchemaV1<unknown, CatalogSearch> {
  return {
    "~standard": {
      version: 1,
      vendor: "pracht-test",
      validate(value) {
        const input = value as Record<string, string | string[] | undefined>;
        const page = input.page === undefined ? 1 : Number(input.page);
        const tag = input.tag === undefined ? [] : ([] as string[]).concat(input.tag);
        const result: StandardSchemaV1.Result<CatalogSearch> =
          Number.isInteger(page) && page >= 1
            ? {
                value: {
                  page,
                  tag,
                  ...(typeof input.q === "string" ? { q: input.q } : {}),
                },
              }
            : { issues: [{ message: "Expected a positive integer", path: [{ key: "page" }] }] };
        return async ? Promise.resolve(result) : result;
      },
    },
  };
}

const search = catalogSchema();

function createApp(render: "ssr" | "ssg" = "ssr") {
  return defineApp({
    shells: { public: "./shells/public.tsx" },
    routes: [
      route("/catalog", "./routes/catalog.tsx", { id: "catalog", render, shell: "public" }),
      route("/plain", "./routes/plain.tsx", { id: "plain", render: "ssr" }),
    ],
  });
}

function createRegistry(overrides: Record<string, unknown> = {}) {
  const loaderCalls: unknown[] = [];
  const registry = {
    routeModules: {
      "./routes/catalog.tsx": async () => ({
        search,
        loader: (args: LoaderArgs & SearchArgs<typeof search>) => {
          loaderCalls.push(args.search);
          return { page: args.search.page };
        },
        head: (args: HeadArgs & SearchArgs<typeof search>) => ({
          title: `Catalog page ${args.search.page}`,
        }),
        Component: () => {
          const parsed = useSearch<CatalogSearch>();
          return h(
            "p",
            { id: "search" },
            `page=${parsed.page}:${typeof parsed.page} tags=${parsed.tag.join(",")}`,
          );
        },
        ErrorBoundary: ({ error }: ErrorBoundaryProps) =>
          h(
            "p",
            { id: "error" },
            `${error.status} ${error.message} ${JSON.stringify(error.issues)}`,
          ),
        ...overrides,
      }),
      "./routes/plain.tsx": async () => ({
        loader: (args: LoaderArgs) => ({ search: args.search }),
        Component: () => h("pre", { id: "raw" }, JSON.stringify(useSearch())),
      }),
    },
    shellModules: {
      "./shells/public.tsx": async () => ({
        Shell: ({ children }: { children?: ComponentChildren }) => h("main", null, children),
      }),
    },
  };
  return { registry, loaderCalls };
}

describe("route search schemas", () => {
  it("parses the query before the loader, head(), and the rendered tree read it", async () => {
    const { registry, loaderCalls } = createRegistry();
    const response = await handlePrachtRequest({
      app: createApp(),
      registry,
      request: new Request("http://localhost/catalog?page=2&tag=a&tag=b"),
    });

    expect(response.status).toBe(200);
    expect(loaderCalls).toEqual([{ page: 2, tag: ["a", "b"] }]);
    const html = await response.text();
    expect(html).toContain("<title>Catalog page 2</title>");
    expect(html).toContain('<p id="search">page=2:number tags=a,b</p>');
  });

  it("applies schema defaults when the query is empty", async () => {
    const { registry, loaderCalls } = createRegistry();
    const response = await handlePrachtRequest({
      app: createApp(),
      registry,
      request: new Request("http://localhost/catalog"),
    });

    expect(response.status).toBe(200);
    expect(loaderCalls).toEqual([{ page: 1, tag: [] }]);
  });

  it("answers a rejected query with 400 through the route's error boundary", async () => {
    const { registry, loaderCalls } = createRegistry();
    const response = await handlePrachtRequest({
      app: createApp(),
      registry,
      request: new Request("http://localhost/catalog?page=zero"),
    });

    expect(response.status).toBe(400);
    expect(loaderCalls).toEqual([]);
    const html = await response.text();
    expect(html).toContain("400 Invalid search params");
    expect(html).toContain(
      JSON.stringify([
        { in: "query", message: "Expected a positive integer", path: ["page"] },
      ]).replace(/"/g, "&quot;"),
    );
  });

  it("serializes the issues into route-state errors for client navigation", async () => {
    const { registry } = createRegistry();
    const response = await handlePrachtRequest({
      app: createApp(),
      registry,
      request: new Request("http://localhost/catalog?page=-1", {
        headers: { "x-pracht-route-state-request": "1" },
      }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error).toMatchObject({
      message: "Invalid search params",
      status: 400,
      issues: [{ in: "query", message: "Expected a positive integer", path: ["page"] }],
    });
  });

  it("awaits asynchronous schemas", async () => {
    const asyncSearch = catalogSchema({ async: true });
    const { registry, loaderCalls } = createRegistry({ search: asyncSearch });
    const response = await handlePrachtRequest({
      app: createApp(),
      registry,
      request: new Request("http://localhost/catalog?page=3"),
    });

    expect(response.status).toBe(200);
    expect(loaderCalls).toEqual([{ page: 3, tag: [] }]);
  });

  it("hands routes without a schema the raw query record", async () => {
    const { registry } = createRegistry();
    const response = await handlePrachtRequest({
      app: createApp(),
      registry,
      request: new Request("http://localhost/plain?a=1&b=2&b=3", {
        headers: { "x-pracht-route-state-request": "1" },
      }),
    });

    expect(await response.json()).toMatchObject({
      data: { search: { a: "1", b: ["2", "3"] } },
    });
  });

  it("prerenders SSG routes against an empty query, so defaults apply", async () => {
    const { registry, loaderCalls } = createRegistry();
    const pages = await prerenderApp({ app: createApp("ssg"), registry });

    const catalog = pages.find((page) => page.path === "/catalog");
    expect(loaderCalls).toEqual([{ page: 1, tag: [] }]);
    expect(catalog?.html).toContain('<p id="search">page=1:number tags=</p>');
  });
});

describe("parseRouteSearch", () => {
  it("reads the query from a URL and ignores exports that are not schemas", async () => {
    expect(await parseRouteSearch(undefined, "/catalog?x=1&x=2")).toEqual({
      value: { x: ["1", "2"] },
    });
    expect(await parseRouteSearch(() => "not a schema", "http://localhost/?q=a")).toEqual({
      value: { q: "a" },
    });
  });

  it("returns the 400 route error with normalized issues", async () => {
    expect(await parseRouteSearch(search, "/catalog?page=0")).toEqual({
      error: {
        message: "Invalid search params",
        name: "PrachtHttpError",
        status: 400,
        issues: [{ in: "query", message: "Expected a positive integer", path: ["page"] }],
      },
    });
  });
});
