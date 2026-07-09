import { afterEach, describe, expect, it, vi } from "vitest";

import {
  _resetNavigationForTesting,
  beginLoadingNavigation,
  beginSubmittingNavigation,
  createNavigationLocation,
  getNavigation,
  settleNavigation,
  subscribeToNavigation,
} from "../src/navigation-state.ts";

afterEach(() => {
  _resetNavigationForTesting();
});

describe("navigation state store", () => {
  it("starts idle", () => {
    expect(getNavigation()).toEqual({ state: "idle" });
  });

  it("tracks a loading navigation and settles back to idle", () => {
    const location = createNavigationLocation("/dashboard?tab=a");
    const token = beginLoadingNavigation(location);

    expect(getNavigation()).toEqual({ state: "loading", location });

    settleNavigation(token);
    expect(getNavigation()).toEqual({ state: "idle" });
  });

  it("tracks a submitting navigation with its form data", () => {
    const formData = new FormData();
    formData.set("title", "hello");
    const location = createNavigationLocation("/api/projects");
    const token = beginSubmittingNavigation(location, formData);

    const navigation = getNavigation();
    expect(navigation.state).toBe("submitting");
    expect(navigation.formData).toBe(formData);
    expect(navigation.location?.pathname).toBe("/api/projects");

    settleNavigation(token);
    expect(getNavigation()).toEqual({ state: "idle" });
  });

  it("ignores settling a superseded navigation", () => {
    const first = beginLoadingNavigation(createNavigationLocation("/a"));
    beginLoadingNavigation(createNavigationLocation("/b"));

    settleNavigation(first);

    const navigation = getNavigation();
    expect(navigation.state).toBe("loading");
    expect(navigation.location?.pathname).toBe("/b");
  });

  it("ignores settling the same token twice after a new navigation began", () => {
    const first = beginLoadingNavigation(createNavigationLocation("/a"));
    settleNavigation(first);
    const second = beginLoadingNavigation(createNavigationLocation("/b"));

    settleNavigation(first);
    expect(getNavigation().state).toBe("loading");

    settleNavigation(second);
    expect(getNavigation()).toEqual({ state: "idle" });
  });

  it("notifies subscribers on every transition and supports unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToNavigation(listener);

    const token = beginLoadingNavigation(createNavigationLocation("/a"));
    settleNavigation(token);

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls[0][0].state).toBe("loading");
    expect(listener.mock.calls[1][0].state).toBe("idle");

    unsubscribe();
    beginLoadingNavigation(createNavigationLocation("/b"));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("parses navigation locations including search and hash", () => {
    const location = createNavigationLocation("/docs/intro?q=router#setup");
    expect(location).toEqual({
      hash: "#setup",
      href: "/docs/intro?q=router#setup",
      pathname: "/docs/intro",
      search: "?q=router",
    });
  });
});
