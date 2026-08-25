import { DEV_ROUTE_DATA_STALE_EVENT } from "@pracht/core/client";

/**
 * Tell open pages that a route module's server half changed.
 *
 * A route module's `loader`, `head`, `headers`, and `getStaticPaths` are
 * stripped out of the browser copy, so Fast Refresh — which patches only what
 * the browser runs — leaves the document holding data the server would no
 * longer send. Before Fast Refresh reached route modules this was invisible:
 * every route edit reloaded the page, and the reload fetched the new data.
 *
 * The generated client entry listens for this event and re-fetches route state
 * through the same path `useRevalidate()` uses, so the data is as fresh as the
 * reload made it while client state survives.
 */
interface RouteDataStaleServerLike {
  environments?: {
    client?: { hot?: { send(payload: { type: "custom"; event: string }): void } };
  };
}

export function sendRouteDataStale(server: RouteDataStaleServerLike): boolean {
  const hot = server.environments?.client?.hot;
  if (!hot) return false;
  hot.send({ type: "custom", event: DEV_ROUTE_DATA_STALE_EVENT });
  return true;
}
