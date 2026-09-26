import { createContext } from "preact";
import { useContext } from "preact/hooks";

import type { RegionLoaderData } from "./types.ts";

/**
 * Loader data of the region being rendered. Provided by the server renderer
 * around each region component; a region never renders in the browser (its
 * client module is a placeholder), so there is no client-side value.
 */
export const RegionDataContext = /* @__PURE__ */ createContext<unknown>(undefined);

/**
 * Read the value the enclosing region's `loader` returned.
 *
 * ```tsx
 * export async function loader({ context }: RegionLoaderArgs) {
 *   return { count: await cartCount(context.session) };
 * }
 *
 * export default function CartCount() {
 *   const { count } = useRegionData<typeof loader>();
 *   return <a href="/cart">Cart ({count})</a>;
 * }
 * ```
 */
export function useRegionData<T = unknown>(): RegionLoaderData<T> {
  return useContext(RegionDataContext) as RegionLoaderData<T>;
}
