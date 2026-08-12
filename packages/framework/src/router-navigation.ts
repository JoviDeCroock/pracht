import { createContext } from "preact";
import { useContext } from "preact/hooks";

import type { NavigateOptions, RouteId, RouteTarget } from "./types.ts";

export interface NavigateFn {
  (to: string, options?: NavigateOptions): Promise<void>;
  <TRoute extends RouteId>(to: RouteTarget<TRoute>, options?: NavigateOptions): Promise<void>;
}

export const NavigateContext = createContext<NavigateFn>(async () => {});

export function useNavigate(): NavigateFn {
  return useContext(NavigateContext);
}
