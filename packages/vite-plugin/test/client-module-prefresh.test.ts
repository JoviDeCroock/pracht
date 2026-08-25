import { describe, expect, it, vi } from "vitest";

import { createClientModulePrefreshPlugin } from "../src/client-module-prefresh.ts";
import { toPrachtClientPrefreshId } from "../src/client-module-query.ts";

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
    // Satisfies prefresh's extension filter while staying distinct from the id
    // of the authored file, which can be in the client graph at the same time.
    expect(transform).toHaveBeenCalledWith("source", "/app/src/routes/home.pracht-client.tsx", {
      ssr: false,
    });
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

describe("toPrachtClientPrefreshId", () => {
  // Prefresh's filter is anchored at the end of the id, so the real extension
  // has to stay last; its `/\.tsx?$/` parser check reads the same position.
  it.each([
    ["/app/src/routes/home.tsx", "/app/src/routes/home.pracht-client.tsx"],
    ["/app/src/routes/home.ts", "/app/src/routes/home.pracht-client.ts"],
    ["/app/src/routes/home.jsx", "/app/src/routes/home.pracht-client.jsx"],
    ["/app/src/routes/home.js", "/app/src/routes/home.pracht-client.js"],
    ["/app/src/routes/home.mjs", "/app/src/routes/home.pracht-client.mjs"],
    ["/app/src/routes/home.cts", "/app/src/routes/home.pracht-client.cts"],
  ])("keeps the extension of %s last", (path, expected) => {
    expect(toPrachtClientPrefreshId(`${path}?pracht-client`)).toBe(expected);
  });

  // A second query still distinguishes module instances, so it has to reach the
  // key too — folded into the basename rather than left as a query.
  it("folds a remaining query into the basename", () => {
    expect(toPrachtClientPrefreshId("/app/src/routes/home.tsx?pracht-client&used=1")).toBe(
      "/app/src/routes/home.pracht-client.used_1.tsx",
    );
  });

  it("never collides with the authored file's own id", () => {
    expect(toPrachtClientPrefreshId("/app/src/routes/home.tsx?pracht-client")).not.toBe(
      "/app/src/routes/home.tsx",
    );
  });

  // Prefresh rejects these anyway; leave them recognizable rather than inventing
  // a `.tsx` that would make it transform Markdown.
  it("leaves formats prefresh does not accept query-stripped", () => {
    expect(toPrachtClientPrefreshId("/app/src/routes/post.md?pracht-client")).toBe(
      "/app/src/routes/post.md",
    );
  });
});
