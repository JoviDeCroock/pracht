import { createContext } from "preact";
import { useContext } from "preact/hooks";

import type { ServerIslandLoaderData } from "./types.ts";

/**
 * Loader data of the server island being rendered. Provided by the server renderer
 * around each server island component; a server island never renders in the browser (its
 * client module is a placeholder), so there is no client-side value.
 */
export const ServerIslandDataContext = /* @__PURE__ */ createContext<unknown>(undefined);

/**
 * Read the value the enclosing server island's `loader` returned.
 *
 * ```tsx
 * export async function loader({ context }: ServerIslandLoaderArgs) {
 *   return { count: await cartCount(context.session) };
 * }
 *
 * export default function CartCount() {
 *   const { count } = useServerIslandData<typeof loader>();
 *   return <a href="/cart">Cart ({count})</a>;
 * }
 * ```
 */
export function useServerIslandData<T = unknown>(): ServerIslandLoaderData<T> {
  return useContext(ServerIslandDataContext) as ServerIslandLoaderData<T>;
}
