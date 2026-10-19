// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/runtime-static.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime-static.ts")>();
  return { ...actual, IS_STATIC_TARGET: true };
});

import { createExitApp, createExitModules, defineExitTable } from "./router-exit-table.ts";
import { mountRouter, teardownRouterHarness } from "./router-harness.ts";

afterEach(teardownRouterHarness);

describe("navigate() document exits on the static-export SPA fallback boot", () => {
  defineExitTable(["staticFallback"]);
});

describe("R497-1: the static SPA fallback never reloads forever", () => {
  const bootCrash = () =>
    mountRouter({
      app: createExitApp("spa"),
      routeModules: createExitModules(),
      url: "/crash",
      staticFallbackBoot: true,
    });

  it("a fallback boot whose route throws does not reload, however often the host serves it", async () => {
    for (let boot = 0; boot < 3; boot++) {
      const harness = await bootCrash();
      expect(harness.bootError).toBeInstanceOf(Error);
      expect(harness.handoffs).toEqual([]);
    }
  });

  it("a client navigation to a throwing route reloads once, and the fallback it lands on stops", async () => {
    const page = await mountRouter({
      app: createExitApp("spa"),
      routeModules: createExitModules(),
    });
    await page.navigate("/crash");
    expect(page.handoffs).toEqual([{ kind: "reload", url: "/crash" }]);

    // The host answers that reload with the fallback document.
    const fallback = await bootCrash();
    expect(fallback.handoffs).toEqual([]);
  });
});
