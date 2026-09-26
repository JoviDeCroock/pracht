---
title: TanStack Query
lead: Use TanStack Query in a pracht app with @pracht/query. Queries fetched on the server arrive in the browser cache with the page and with every client navigation, so components never fetch the same data twice.
breadcrumb: TanStack Query
prev:
  href: /docs/recipes/forms
  title: Forms
next:
  href: /docs/recipes/view-transitions
  title: View Transitions
---

## Install

`@pracht/query` connects [`@tanstack/preact-query`](https://tanstack.com/query) to pracht's render pipeline. It creates one `QueryClient` per server request, sends what the server fetched to the browser, and fills the browser's cache before the page hydrates.

```bash
npm install @pracht/query @tanstack/preact-query
```

## 1. Add the app root

Create `src/root.ts` and re-export the ready-made root:

```ts [src/root.ts]
export * from "@pracht/query/root";
```

The [app root](/docs/shells#the-app-root) renders above every shell and is never remounted, so the browser's `QueryClient` and its cache survive every navigation, including one that switches shells. On the server, `setup()` runs once per request, so two visitors never share a cache.

## 2. Describe your queries

Write query options once and share them between loaders and components. The `queryFn` runs on the server during a request and in the browser when a query refetches, so it has to work in both places:

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

Here is what happens:

- **First load.** The loader fills the request's cache, and the component renders from it. After the render, the cache is added to the page. The browser hydrates it into its own `QueryClient` before hydration starts, so `useSuspenseQuery` finds the data and does not fetch.
- **Client navigation.** The loader runs on the server as usual. The queries it fetched come back in the same route-state response as the loader data, and go into the browser cache before the new page renders. Prefetched links carry them too.
- **After that.** TanStack Query takes over: refetch on focus, `staleTime`, background refreshes, and so on.

A component may also start a query that the loader didn't prefetch. `useSuspenseQuery` suspends during the server render, and whatever it fetched is still included in the page.

## Mutations

A successful non-`read` [capability](/docs/capabilities) call invalidates every query, the same way pracht revalidates route data after one. That covers `<Form capability>` and `callCapability()` with no extra code. For anything else, use `useMutation` and invalidate what changed:

```tsx [src/components/rename-post.tsx]
import { useMutation, useQueryClient } from "@tanstack/preact-query";

export function RenamePost({ id }: { id: string }) {
  const queryClient = useQueryClient();
  const rename = useMutation({
    mutationFn: async (title: string) => {
      const response = await fetch(`/api/posts/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (!response.ok) throw new Error("Rename failed");
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["post", id] }),
  });

  return (
    <button disabled={rename.isPending} onClick={() => rename.mutate("New title")}>
      Rename
    </button>
  );
}
```

## Configuration

`createQueryRoot()` takes the `QueryClient` config (or a function that returns it for each side), `dehydrate`/`hydrate` options, and whether capability calls invalidate queries:

```ts [src/root.ts]
import { createQueryRoot } from "@pracht/query";

export const { setup, Root, dehydrate, hydrate } = createQueryRoot({
  client: ({ isServer }) => ({
    defaultOptions: { queries: { staleTime: isServer ? 0 : 30_000 } },
  }),
  invalidateOnCapability: true,
});
```

The defaults are a `staleTime` of 60 seconds (without one, every query the server just fetched would refetch as soon as it mounted) and `retry: false` on the server, so a failing request fails fast instead of holding the response.

To type `args.root` in loaders, register the root state:

```ts [src/env.d.ts]
import type { QueryRootState } from "@pracht/query";

declare module "@pracht/core" {
  interface Register {
    root: QueryRootState;
  }
}
```

## Limits

- **Only successful queries are sent.** A query that failed or is still pending on the server fetches again in the browser.
- **Streaming routes** (`streaming: true`) write the cache into the page before the shell renders, so only queries the loader awaited are included. Await the queries a streamed route needs in its loader.
- **Islands** (`hydration: "islands"`) hydrate one component at a time without the app root, so `useQuery` is not available inside an island.
- **The data has to be JSON.** The cache travels as JSON, so `Date`, `Map`, and class instances arrive as their JSON form. Return plain data from `queryFn`, or convert with `select`.
