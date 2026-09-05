// @vitest-environment jsdom
import { Component, h, render } from "preact";
import type { ComponentChildren } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PrachtRuntimeProvider, useRouteData } from "../src/index.ts";
import type { LoaderArgs, RouteLoaderData } from "../src/index.ts";

let scratch: HTMLDivElement;

describe("useRouteData", () => {
  beforeEach(() => {
    scratch = document.createElement("div");
    document.body.appendChild(scratch);
  });

  afterEach(() => {
    render(null, scratch);
    scratch.remove();
    vi.restoreAllMocks();
  });

  it("returns the active route's data when called with a route id", () => {
    let captured: unknown;

    function Consumer() {
      captured = useRouteData("dashboard");
      return null;
    }

    render(
      h(PrachtRuntimeProvider, {
        children: h(Consumer, null),
        data: { user: "Ada" },
        routeId: "dashboard",
        url: "/dashboard",
      }),
      scratch,
    );

    expect(captured).toEqual({ user: "Ada" });
  });

  // The typed overload promises `RouteDataFor<"settings">`. The runtime holds
  // one route's data, so honouring the argument means refusing — handing back
  // the dashboard's data under the settings route's type is the bug.
  it("throws when the route id is not the active route", () => {
    let thrown: unknown;

    function Consumer() {
      useRouteData("settings");
      return null;
    }

    class Boundary extends Component<{ children: ComponentChildren }> {
      static getDerivedStateFromError(error: unknown) {
        thrown = error;
        return {};
      }
      render() {
        return thrown ? null : this.props.children;
      }
    }

    render(
      h(PrachtRuntimeProvider, {
        children: h(Boundary, { children: h(Consumer, null) }),
        data: { user: "Ada" },
        routeId: "dashboard",
        url: "/dashboard",
      }),
      scratch,
    );

    const message = (thrown as Error).message;
    expect(message).toContain("useRouteData");
    expect(message).toContain("settings");
    expect(message).toContain("dashboard");
  });

  it("returns undefined outside a runtime provider, with or without a route id", () => {
    let withId: unknown = "unset";

    function Consumer() {
      withId = useRouteData("dashboard");
      return null;
    }

    render(h(Consumer, null), scratch);

    expect(withId).toBeUndefined();
  });

  it("keeps the loader-generic form working without a route id", () => {
    let captured: unknown;

    function Consumer() {
      captured = useRouteData<typeof loader>();
      return null;
    }

    render(
      h(PrachtRuntimeProvider, {
        children: h(Consumer, null),
        data: { user: { name: "Ada" } },
        routeId: "dashboard",
        url: "/dashboard",
      }),
      scratch,
    );

    expect(captured).toEqual({ user: { name: "Ada" } });
  });
});

async function loader(_args: LoaderArgs) {
  return { user: { name: "Ada" } };
}

describe("RouteLoaderData", () => {
  type ModuleWithLoader = { loader: typeof loader };
  type ModuleWithoutLoader = { Component: () => null };

  it("extracts the awaited loader return type from a route module", () => {
    const data: RouteLoaderData<ModuleWithLoader> = { user: { name: "Ada" } };
    expect(data.user.name).toBe("Ada");
  });

  it("resolves to undefined for modules without a loader export", () => {
    const data: RouteLoaderData<ModuleWithoutLoader> = undefined;
    expect(data).toBeUndefined();
  });

  it("prefers the separate loader module over the route module", () => {
    const data: RouteLoaderData<ModuleWithLoader, ModuleWithoutLoader> = {
      user: { name: "Ada" },
    };
    expect(data.user.name).toBe("Ada");
  });

  it("falls back to the route module when the loader module has no loader", () => {
    const data: RouteLoaderData<ModuleWithoutLoader, ModuleWithLoader> = {
      user: { name: "Ada" },
    };
    expect(data.user.name).toBe("Ada");
  });
});
