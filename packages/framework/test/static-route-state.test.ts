import { describe, expect, it } from "vitest";

import {
  buildStaticRouteStateUrl,
  routePathFromStaticRouteStateUrl,
} from "../src/runtime-client-fetch.ts";

describe("static route-state paths", () => {
  it.each([
    ["/", "/_pracht/state/index.json"],
    ["/?page=2#results", "/_pracht/state/index.json"],
    ["/index", "/_pracht/state/index/index.json"],
    ["/docs/routing", "/_pracht/state/docs/routing/index.json"],
    ["/docs/routing/", "/_pracht/state/docs/routing/index.json"],
    ["/feed.xml", "/_pracht/state/feed.xml/index.json"],
  ])("maps %s to a collision-free snapshot", (route, snapshot) => {
    expect(buildStaticRouteStateUrl(route)).toBe(snapshot);
    expect(routePathFromStaticRouteStateUrl(snapshot)).toBe(
      route.split(/[?#]/)[0].replace(/\/$/, "") || "/",
    );
  });

  it("rejects paths outside the snapshot layout", () => {
    expect(routePathFromStaticRouteStateUrl("/_pracht/state.json")).toBeNull();
    expect(routePathFromStaticRouteStateUrl("/_pracht/state/docs.json")).toBeNull();
    expect(routePathFromStaticRouteStateUrl("/_pracht/state/../index.json")).toBeNull();
  });
});
