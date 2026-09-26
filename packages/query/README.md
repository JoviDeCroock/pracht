# @pracht/query

[TanStack Query](https://tanstack.com/query) for [Pracht](https://github.com/JoviDeCroock/pracht),
built on `@tanstack/preact-query`.

- One `QueryClient` per server request, never shared between visitors.
- Queries fetched on the server (in a loader or during the render) are sent
  with the page and hydrated into the browser cache before hydration.
- Client navigations carry the queries their loader fetched in the same
  route-state response as the loader data.
- A successful non-`read` capability call invalidates queries, the same way
  pracht revalidates route data.

```bash
npm install @pracht/query @tanstack/preact-query
```

## Quick start

```ts
// src/root.ts — the app root renders above every shell and is never remounted
export * from "@pracht/query/root";
```

```tsx
// src/routes/post.tsx
import { getQueryClient } from "@pracht/query";
import type { LoaderArgs, RouteComponentProps } from "@pracht/core";
import { queryOptions, useSuspenseQuery } from "@tanstack/preact-query";

const postQuery = (id: string) =>
  queryOptions({
    queryKey: ["post", id],
    queryFn: () => fetch(`https://api.example.com/posts/${id}`).then((r) => r.json()),
  });

export async function loader(args: LoaderArgs) {
  await getQueryClient(args).ensureQueryData(postQuery(args.params.id!));
}

export default function Post({ params }: RouteComponentProps) {
  const { data } = useSuspenseQuery(postQuery(params.id!)); // no refetch after hydration
  return <h1>{data.title}</h1>;
}
```

## Options

```ts
// src/root.ts
import { createQueryRoot } from "@pracht/query";

export const { setup, Root, dehydrate, hydrate } = createQueryRoot({
  // QueryClient config, or a function of { isServer, request } returning it.
  client: { defaultOptions: { queries: { staleTime: 30_000 } } },
  // Passed to TanStack Query's dehydrate() / hydrate().
  dehydrate: {},
  hydrate: {},
  // Invalidate queries after successful non-read capability calls (default true).
  invalidateOnCapability: true,
});
```

Defaults: `staleTime: 60_000`, and `retry: false` on the server.

See the [TanStack Query recipe](https://pracht.resynapse.dev/docs/recipes/tanstack-query)
for mutations, typing `args.root`, and limits (streaming routes, islands).
