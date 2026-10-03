---
title: TanStack Query
lead: Use TanStack Query in a pracht app with @pracht/query. Queries fetched on the server arrive in the browser cache with the page and with every client navigation, so components render from the cache instead of fetching again.
breadcrumb: TanStack Query
prev:
  href: /docs/recipes/forms
  title: Forms
next:
  href: /docs/recipes/view-transitions
  title: View Transitions
---

## Install

`@pracht/query` connects [`@tanstack/preact-query`](https://tanstack.com/query) to pracht. It creates one `QueryClient` per server request and fills the browser's cache with what the server fetched before the page hydrates.

```bash
npm install @pracht/query @tanstack/preact-query
```

## 1. Register the app root

Re-export the ready-made root, and register it in the manifest:

```ts [src/root.ts]
export * from "@pracht/query/root";
```

```ts [src/routes.ts]
import { defineApp, route } from "@pracht/core";

export const app = defineApp({
  root: () => import("./root.ts"),
  routes: [route("/posts/:id", () => import("./routes/post.tsx"))],
});
```

The [app root](/docs/shells#the-app-root) is never remounted, so the browser's `QueryClient` keeps its cache across every navigation, including one that switches shells. On the server, each request gets its own `QueryClient`. In the pages router, put the re-export in `pages/_root.ts` instead.

## 2. Describe your queries

Share query options between loaders and components. The `queryFn` runs on the server during a request and in the browser when a query refetches, so it has to work in both places:

```ts [src/queries/posts.ts]
import { queryOptions } from "@tanstack/preact-query";

export interface Post {
  id: string;
  title: string;
}

export const postQuery = (id: string) =>
  queryOptions({
    queryKey: ["post", id],
    queryFn: async (): Promise<Post> => {
      const response = await fetch(`https://api.example.com/posts/${id}`);
      if (!response.ok) throw new Error(`Post ${id} failed to load (${response.status})`);
      return response.json();
    },
  });
```

## 3. Prefetch in the loader, read in the component

```tsx [src/routes/post.tsx]
import { getQueryClient } from "@pracht/query";
import type { LoaderArgs, RouteComponentProps } from "@pracht/core";
import { useSuspenseQuery } from "@tanstack/preact-query";

import { postQuery } from "../queries/posts.ts";

export async function loader(args: LoaderArgs) {
  await getQueryClient(args).ensureQueryData(postQuery(args.params.id!));
}

export default function PostPage({ params }: RouteComponentProps) {
  const { data: post } = useSuspenseQuery(postQuery(params.id!));
  return <h1>{post.title}</h1>;
}
```

- **First load.** The component renders from the cache the loader filled, and the page carries that cache to the browser. `useSuspenseQuery` finds the data there and does not fetch.
- **Client navigation.** The queries the loader fetched come back in the same route-state response as the loader data, including for prefetched links, and land in the browser cache before the new page renders.
- **After that.** TanStack Query takes over: `staleTime`, refetch on focus, background refreshes.

A component can also start a query the loader didn't prefetch. `useSuspenseQuery` waits for it during the server render, and the page carries it too.

## Mutations

A successful non-`read` [capability](/docs/capabilities) call, from `<Form capability>` or `callCapability()`, invalidates every query, the same way pracht revalidates route data. For a mutation that goes through an API route, invalidate what changed in `useMutation`'s `onSuccess`, as in any TanStack Query app.

## Configuration

`createQueryRoot()` takes the `QueryClient` config (or a function of `{ isServer }` that returns it), `dehydrate`/`hydrate` options, and `invalidateOnCapability`:

```ts [src/root.ts]
import { createQueryRoot } from "@pracht/query";

export const { setup, Root, dehydrate, hydrate } = createQueryRoot({
  client: { defaultOptions: { queries: { staleTime: 30_000 } } },
  invalidateOnCapability: true,
});
```

Queries default to a `staleTime` of 60 seconds, so data the server just fetched does not refetch on mount, and to `retry: false` on the server, so a failing request fails fast. `pracht typegen` types `args.root` as `{ queryClient }`.

## Limits

- **Only successful queries are sent.** A query that failed or is still pending on the server fetches again in the browser.
- **SSG and ISG pages** carry the data from when they were rendered. Once it is older than `staleTime`, the browser refetches it after hydration.
- **Streaming routes** (`streaming: true`) send the cache before the shell renders, so only queries the loader awaited go with the page. Wrap a component that reads any other query in `<Suspense>` from `@pracht/core`, or the streamed render fails.
- **Islands** (`hydration: "islands"`) render without the app root, on the server too, so an island that calls `useQuery` fails the server render with an error naming the island. Read the query in the route component and pass the island what it needs as props.
- **The data has to be JSON.** `Date`, `Map`, and class instances arrive as their JSON form. Return plain data from `queryFn`, or convert with `select`.
