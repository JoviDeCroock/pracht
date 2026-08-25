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

function deferred<T>(): {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function settleRefresh(): Promise<void> {
  await Promise.resolve();
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

  it("serializes overlapping refreshes so the latest save settles last", async () => {
    const first = deferred<unknown>();
    mocks.runtimes.add(runtime());
    mocks.revalidateRouteData
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ greeting: "latest" });

    refreshDevRouteData();
    refreshDevRouteData();

    expect(mocks.revalidateRouteData).toHaveBeenCalledTimes(1);

    first.resolve({ greeting: "old" });
    await settleRefresh();

    expect(mocks.revalidateRouteData).toHaveBeenCalledTimes(2);
    expect(reload).not.toHaveBeenCalled();
  });

  it("does not reload for a failed refresh superseded by a newer save", async () => {
    const first = deferred<unknown>();
    mocks.runtimes.add(runtime());
    mocks.revalidateRouteData
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ greeting: "fixed" });

    refreshDevRouteData();
    refreshDevRouteData();
    first.reject(new Error("obsolete loader failure"));
    await settleRefresh();

    expect(mocks.revalidateRouteData).toHaveBeenCalledTimes(2);
    expect(reload).not.toHaveBeenCalled();
  });
});
