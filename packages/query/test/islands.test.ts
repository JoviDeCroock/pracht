import {
  defineApp,
  handlePrachtRequest,
  registerServerIslands,
  route,
  setIslandsClientEntryUrl,
  type LoaderArgs,
} from "@pracht/core";
import { queryOptions, useQuery, useSuspenseQuery } from "@tanstack/preact-query";
import { h } from "preact";
import { expect, it } from "vitest";

import { getQueryClient } from "../src/index.ts";
import * as defaultRoot from "../src/root.ts";

const postQuery = queryOptions({
  queryKey: ["post"],
  queryFn: async () => ({ title: "Hello" }),
});

function Title() {
  const { data } = useSuspenseQuery(postQuery);
  return h("h1", null, data.title);
}

function Island() {
  const { data } = useQuery(postQuery);
  return h("button", null, data?.title ?? "loading");
}

it("fails an island that reads the QueryClient on the server, naming the island", async () => {
  registerServerIslands({ "/src/islands/Likes.tsx": { default: Island } });
  setIslandsClientEntryUrl("/assets/islands-client.js");
  const errors: unknown[] = [];

  const response = await handlePrachtRequest({
    app: defineApp({
      routes: [route("/", "./routes/page.tsx", { render: "ssr", hydration: "islands" })],
    }),
    registry: {
      routeModules: {
        "./routes/page.tsx": async () => ({
          loader: async (args: LoaderArgs) => {
            await getQueryClient(args).ensureQueryData(postQuery);
          },
          Component: () => h("main", null, h(Title, null), h(Island, null)),
        }),
      },
      rootModules: { "/src/root.ts": async () => defaultRoot },
    },
    request: new Request("http://localhost/"),
    onRouteError: (error) => errors.push(error),
  });

  expect(response.status).toBe(500);
  expect((errors[0] as Error).message).toMatch(
    /^\[pracht\] Island "Likes" \(\/src\/islands\/Likes\.tsx\) threw while rendering: No QueryClient set/,
  );
});
