// @vitest-environment jsdom
import { h, render } from "preact";
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

  it("warns in dev when the route id does not match the active route", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    function Consumer() {
      useRouteData("settings");
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

    expect(warn).toHaveBeenCalledWith(
      'useRouteData("settings") rendered inside route "dashboard"; returning the active route\'s data.',
    );
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
