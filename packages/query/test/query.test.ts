import {
  defineApp,
  handlePrachtRequest,
  route,
  type LoaderArgs,
  type RouteComponentProps,
} from "@pracht/core";
import { QueryClient, queryOptions, useSuspenseQuery } from "@tanstack/preact-query";
import { h } from "preact";
import { describe, expect, it, vi } from "vitest";

import { createQueryRoot, DEFAULT_STALE_TIME, getQueryClient } from "../src/index.ts";
import * as defaultRoot from "../src/root.ts";

function parseHydrationState(html: string): Record<string, any> {
  const match = html.match(
    /<script id="pracht-state" type="application\/json">([\s\S]*?)<\/script>/,
  );
  if (!match) throw new Error("Hydration state script not found");
  return JSON.parse(match[1]) as Record<string, any>;
}

describe("createQueryRoot", () => {
  it("creates a new QueryClient for every setup call", () => {
    const root = createQueryRoot();
    const first = root.setup({ request: new Request("http://localhost/"), isServer: true });
    const second = root.setup({ request: new Request("http://localhost/"), isServer: true });
    expect(first.queryClient).toBeInstanceOf(QueryClient);
    expect(first.queryClient).not.toBe(second.queryClient);
  });

  it("defaults staleTime, and disables retries on the server only", () => {
    const root = createQueryRoot();
    const server = root.setup({ request: new Request("http://localhost/"), isServer: true });
    const browser = root.setup({ request: undefined, isServer: false });

    expect(server.queryClient.getDefaultOptions().queries).toEqual({
      staleTime: DEFAULT_STALE_TIME,
      retry: false,
    });
    expect(browser.queryClient.getDefaultOptions().queries).toEqual({
      staleTime: DEFAULT_STALE_TIME,
    });
  });

  it("lets the client config override the defaults", () => {
    const root = createQueryRoot({
      client: ({ isServer }) => ({
        defaultOptions: { queries: { staleTime: isServer ? 0 : 5_000, gcTime: 10 } },
      }),
    });
    const browser = root.setup({ request: undefined, isServer: false });
    expect(browser.queryClient.getDefaultOptions().queries).toEqual({
      staleTime: 5_000,
      gcTime: 10,
    });
  });

  it("sends nothing when the cache is empty, and round-trips a filled one", async () => {
    const root = createQueryRoot();
    const server = root.setup({ request: new Request("http://localhost/"), isServer: true });
    expect(root.dehydrate(server)).toBeUndefined();

    await server.queryClient.prefetchQuery({ queryKey: ["post", 1], queryFn: () => "hello" });
    const snapshot = JSON.parse(JSON.stringify(root.dehydrate(server)));

    const browser = root.setup({ request: undefined, isServer: false });
    root.hydrate(browser, snapshot);
    expect(browser.queryClient.getQueryData(["post", 1])).toBe("hello");
  });

  it("exports a default root from @pracht/query/root", () => {
    expect(Object.keys(defaultRoot).sort()).toEqual(["Root", "dehydrate", "hydrate", "setup"]);
  });
});

describe("getQueryClient", () => {
  it("returns the request's client", () => {
    const queryClient = new QueryClient();
    expect(getQueryClient({ root: { queryClient } })).toBe(queryClient);
  });

  it("explains how to add the root when there is none", () => {
    expect(() => getQueryClient({})).toThrow(/src\/root\.ts/);
  });
});

describe("server rendering", () => {
  const postQuery = (id: string) =>
    queryOptions({
      queryKey: ["post", id],
      queryFn: async () => ({ id, title: `Post ${id}` }),
    });
  const authorQuery = queryOptions({
    queryKey: ["author"],
    queryFn: async () => "Ada",
  });

  function Post({ params }: RouteComponentProps) {
    const { data: post } = useSuspenseQuery(postQuery(params.id!));
    const { data: author } = useSuspenseQuery(authorQuery);
    return h("h1", null, `${post.title} by ${author}`);
  }

  const app = defineApp({
    routes: [route("/posts/:id", "./routes/post.tsx", { render: "ssr" })],
  });

  function createRegistry() {
    return {
      routeModules: {
        "./routes/post.tsx": async () => ({
          loader: async (args: LoaderArgs) => {
            await getQueryClient(args).ensureQueryData(postQuery(args.params.id));
          },
          Component: Post,
        }),
      },
      rootModules: { "/src/root.ts": async () => defaultRoot },
    };
  }

  it("renders loader-fetched and render-fetched queries and ships both", async () => {
    const response = await handlePrachtRequest({
      app,
      registry: createRegistry(),
      request: new Request("http://localhost/posts/7"),
    });
    const html = await response.text();

    expect(html).toContain("<h1>Post 7 by Ada</h1>");
    const state = parseHydrationState(html);
    const keys = state.root.queries.map((query: { queryKey: unknown }) => query.queryKey);
    expect(keys).toEqual(expect.arrayContaining([["post", "7"], ["author"]]));

    // The browser cache starts warm: nothing is stale, so nothing refetches.
    const browser = defaultRoot.setup({ request: undefined, isServer: false });
    defaultRoot.hydrate(browser, state.root);
    const cached = browser.queryClient.getQueryState(["post", "7"]);
    expect(cached?.data).toEqual({ id: "7", title: "Post 7" });
    expect(
      browser.queryClient
        .getQueryCache()
        .find({ queryKey: ["post", "7"] })
        ?.isStale(),
    ).toBe(false);
  });

  it("adds the loader's queries to route-state responses", async () => {
    const response = await handlePrachtRequest({
      app,
      registry: createRegistry(),
      request: new Request("http://localhost/posts/3", {
        headers: { "x-pracht-route-state-request": "1" },
      }),
    });
    const body = (await response.json()) as Record<string, any>;
    expect(body.root.queries).toHaveLength(1);
    expect(body.root.queries[0].queryKey).toEqual(["post", "3"]);
  });

  it("never shares a cache between requests", async () => {
    const queryFn = vi.fn(async () => "fresh");
    const counted = queryOptions({ queryKey: ["counted"], queryFn });
    const registry = {
      routeModules: {
        "./routes/post.tsx": async () => ({
          loader: async (args: LoaderArgs) => {
            await getQueryClient(args).ensureQueryData(counted);
          },
          Component: () => h("p", null, "ok"),
        }),
      },
      rootModules: { "/src/root.ts": async () => defaultRoot },
    };
    for (let i = 0; i < 2; i++) {
      await handlePrachtRequest({
        app,
        registry,
        request: new Request("http://localhost/posts/1"),
      });
    }
    expect(queryFn).toHaveBeenCalledTimes(2);
  });
});
