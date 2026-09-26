import { CAPABILITY_SETTLED_EVENT } from "@pracht/capabilities";
import type { RootModule, RootProps, RootSetupArgs } from "@pracht/core";
import {
  dehydrate,
  hydrate,
  QueryClient,
  QueryClientProvider,
  type DehydratedState,
  type DehydrateOptions,
  type HydrateOptions,
  type QueryClientConfig,
} from "@tanstack/preact-query";
import { h } from "preact";
import type { ComponentChildren } from "preact";
import { useEffect } from "preact/hooks";

/** The app root state `createQueryRoot()` creates. */
export interface QueryRootState {
  queryClient: QueryClient;
}

export interface QueryRootOptions {
  /**
   * `QueryClient` configuration, or a function returning it. The function
   * runs once per server request and once in the browser, so it can pick
   * different defaults for each side.
   */
  client?: QueryClientConfig | ((args: RootSetupArgs) => QueryClientConfig);
  /** Passed to TanStack Query's `dehydrate()` on the server. */
  dehydrate?: DehydrateOptions;
  /** Passed to TanStack Query's `hydrate()` in the browser. */
  hydrate?: HydrateOptions;
  /**
   * Invalidate every query after a successful non-`read` capability call,
   * the same way pracht revalidates route data. Defaults to `true`.
   */
  invalidateOnCapability?: boolean;
}

/**
 * The default `staleTime` for queries, in milliseconds. Without one, every
 * query the server already fetched would refetch as soon as it mounts in the
 * browser.
 */
export const DEFAULT_STALE_TIME = 60_000;

export type QueryRoot = Required<
  Pick<RootModule<QueryRootState>, "setup" | "Root" | "dehydrate" | "hydrate">
>;

/**
 * Build the app root that wires TanStack Query into pracht. Export its
 * members from `src/root.ts`:
 *
 * ```ts
 * import { createQueryRoot } from "@pracht/query";
 * export const { setup, Root, dehydrate, hydrate } = createQueryRoot();
 * ```
 */
export function createQueryRoot(options: QueryRootOptions = {}): QueryRoot {
  const invalidateOnCapability = options.invalidateOnCapability !== false;

  function QueryRoot({ state, children }: RootProps<QueryRootState>): ComponentChildren {
    const { queryClient } = state;
    useEffect(() => {
      if (!invalidateOnCapability) return;
      const onSettled = (event: Event) => {
        if (shouldInvalidateAfterCapability((event as CustomEvent).detail)) {
          void queryClient.invalidateQueries();
        }
      };
      window.addEventListener(CAPABILITY_SETTLED_EVENT, onSettled);
      return () => window.removeEventListener(CAPABILITY_SETTLED_EVENT, onSettled);
    }, [queryClient]);
    return h(QueryClientProvider, { client: queryClient }, children);
  }

  return {
    setup(args) {
      const config = typeof options.client === "function" ? options.client(args) : options.client;
      const queries = {
        staleTime: DEFAULT_STALE_TIME,
        // A failed server fetch should fail fast; the browser retries on its
        // own schedule after hydration.
        ...(args.isServer ? { retry: false } : {}),
        ...config?.defaultOptions?.queries,
      };
      return {
        queryClient: new QueryClient({
          ...config,
          defaultOptions: { ...config?.defaultOptions, queries },
        }),
      };
    },
    Root: QueryRoot,
    dehydrate(state) {
      const snapshot = dehydrate(state.queryClient, options.dehydrate);
      return snapshot.queries.length > 0 || snapshot.mutations.length > 0 ? snapshot : undefined;
    },
    hydrate(state, snapshot) {
      hydrate(state.queryClient, snapshot as DehydratedState, options.hydrate);
    },
  };
}

/**
 * This request's `QueryClient`, for loaders:
 *
 * ```ts
 * export async function loader(args: LoaderArgs) {
 *   await getQueryClient(args).ensureQueryData(postQuery(args.params.id));
 * }
 * ```
 *
 * Queries fetched here are sent to the browser with the page, so a component
 * reading them with `useQuery()` or `useSuspenseQuery()` does not fetch again.
 */
export function getQueryClient(args: { root?: unknown }): QueryClient {
  const root = args.root as Partial<QueryRootState> | undefined;
  if (root && root.queryClient instanceof QueryClient) return root.queryClient;
  throw new Error(
    "getQueryClient(): this request has no QueryClient. Add `src/root.ts` with " +
      '`export * from "@pracht/query/root";` (or the members of `createQueryRoot()`).',
  );
}

function shouldInvalidateAfterCapability(detail: unknown): boolean {
  if (!detail || typeof detail !== "object") return false;
  const settled = detail as { ok?: unknown; effect?: unknown; revalidate?: unknown };
  return settled.ok === true && settled.effect !== "read" && settled.revalidate !== false;
}
