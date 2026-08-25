import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PrachtRuntimeValue } from "../src/runtime-context.ts";

const mocks = vi.hoisted(() => ({
  revalidateRouteData: vi.fn(),
  runtimes: new Set<PrachtRuntimeValue>(),
}));

vi.mock("../src/runtime-context.ts", () => ({
  getMountedRuntimes: () => mocks.runtimes,
}));

vi.mock("../src/runtime-revalidate.ts", () => ({
  revalidateRouteData: mocks.revalidateRouteData,
}));

import { refreshDevRouteData } from "../src/dev-route-refresh.ts";

function runtime(isCurrent?: () => boolean): PrachtRuntimeValue {
  return {
    data: null,
    params: {},
    routeId: "home",
    setData: vi.fn(),
    url: "/",
    ...(isCurrent ? { isCurrent } : {}),
  };
}

async function settleRefresh(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("refreshDevRouteData", () => {
  const reload = vi.fn();

  beforeEach(() => {
    mocks.revalidateRouteData.mockReset();
    mocks.runtimes.clear();
    reload.mockReset();
    vi.stubGlobal("window", { location: { reload } });
  });

  it("keeps the page mounted after a successful refresh", async () => {
    mocks.runtimes.add(runtime());
    mocks.revalidateRouteData.mockResolvedValue({ greeting: "fresh" });

    refreshDevRouteData();
    await settleRefresh();

    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads once when the active route refresh fails", async () => {
    mocks.runtimes.add(runtime());
    mocks.runtimes.add(runtime());
    mocks.revalidateRouteData.mockRejectedValue(new Error("loader failed"));

    refreshDevRouteData();
    await settleRefresh();

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("ignores a failed refresh after its route stops being current", async () => {
    mocks.runtimes.add(runtime(() => false));
    mocks.revalidateRouteData.mockRejectedValue(new Error("stale route failed"));

    refreshDevRouteData();
    await settleRefresh();

    expect(reload).not.toHaveBeenCalled();
  });
});
