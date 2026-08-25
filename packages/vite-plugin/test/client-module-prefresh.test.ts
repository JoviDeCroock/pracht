import { describe, expect, it, vi } from "vitest";

import { createClientModulePrefreshPlugin } from "../src/client-module-prefresh.ts";

function prefreshStub(transform: unknown) {
  return { name: "prefresh", transform } as never;
}

/** The shape `@prefresh/vite` itself rejects: an id that is not a bare `.tsx`. */
const CLIENT_ROUTE_ID = "/app/src/routes/home.tsx?pracht-client";

describe("client-module prefresh bridge", () => {
  it("transforms pracht client route modules through prefresh", async () => {
    const transform = vi.fn().mockResolvedValue({ code: "refreshed" });
    const plugin = createClientModulePrefreshPlugin([prefreshStub(transform)]);

    const result = await (plugin!.transform as any).call({}, "source", CLIENT_ROUTE_ID, {
      ssr: false,
    });

    expect(result).toEqual({ code: "refreshed" });
    // The stripped id is what prefresh's own filter accepts, and what it
    // embeds in component registrations.
    expect(transform).toHaveBeenCalledWith("source", "/app/src/routes/home.tsx", { ssr: false });
  });

  it("ignores modules without the pracht client query", async () => {
    const transform = vi.fn();
    const plugin = createClientModulePrefreshPlugin([prefreshStub(transform)]);

    const result = await (plugin!.transform as any).call({}, "source", "/app/src/x.tsx", {
      ssr: false,
    });

    expect(result).toBeNull();
    expect(transform).not.toHaveBeenCalled();
  });

  it("ignores SSR transforms", async () => {
    const transform = vi.fn();
    const plugin = createClientModulePrefreshPlugin([prefreshStub(transform)]);

    const result = await (plugin!.transform as any).call({}, "source", CLIENT_ROUTE_ID, {
      ssr: true,
    });

    expect(result).toBeNull();
    expect(transform).not.toHaveBeenCalled();
  });

  it("never runs during a production build", () => {
    const plugin = createClientModulePrefreshPlugin([prefreshStub(vi.fn())]);

    expect(plugin!.apply).toBe("serve");
    // Ordering matters: prefresh has to see the module with its server-only
    // exports already stripped by pracht:client-module-transform.
    expect(plugin!.enforce).toBe("post");
  });

  it("finds prefresh inside a nested plugin array", async () => {
    const transform = vi.fn().mockResolvedValue("refreshed");
    const plugin = createClientModulePrefreshPlugin([
      { name: "other" } as never,
      [null, [prefreshStub(transform)]] as never,
    ]);

    await (plugin!.transform as any).call({}, "source", CLIENT_ROUTE_ID, { ssr: false });

    expect(transform).toHaveBeenCalled();
  });

  it("supports the object form of the transform hook", async () => {
    const handler = vi.fn().mockResolvedValue("refreshed");
    const plugin = createClientModulePrefreshPlugin([prefreshStub({ handler })]);

    await (plugin!.transform as any).call({}, "source", CLIENT_ROUTE_ID, { ssr: false });

    expect(handler).toHaveBeenCalled();
  });

  // Fast Refresh being unavailable is a valid configuration, not an error.
  it("returns null when no prefresh plugin is present", () => {
    expect(createClientModulePrefreshPlugin([{ name: "other" } as never])).toBeNull();
    expect(createClientModulePrefreshPlugin([])).toBeNull();
  });
});
