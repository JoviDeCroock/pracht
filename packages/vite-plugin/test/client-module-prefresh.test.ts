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
    expect(transform).toHaveBeenCalledWith(
      "source",
      `pracht-client:${CLIENT_ROUTE_ID.length}:${CLIENT_ROUTE_ID}.tsx`,
      { ssr: false },
    );
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

  it("transforms a bare compiled route format through a synthetic JSX id", async () => {
    const transform = vi.fn().mockResolvedValue({ code: "refreshed" });
    const plugin = createClientModulePrefreshPlugin([prefreshStub(transform)], {
      isRouteOrShellModule: (id) => id === "/app/src/routes/home.tsrx",
    });

    const id = "/app/src/routes/home.tsrx";
    const result = await (plugin!.transform as any).call({}, "source", id, { ssr: false });

    expect(result).toEqual({ code: "refreshed" });
    expect(transform).toHaveBeenCalledWith("source", `pracht-client:${id.length}:${id}.jsx`, {
      ssr: false,
    });
  });

  it("does not double-transform a bare route id prefresh already accepts", async () => {
    const transform = vi.fn();
    const plugin = createClientModulePrefreshPlugin([prefreshStub(transform)], {
      isRouteOrShellModule: () => true,
    });

    const result = await (plugin!.transform as any).call({}, "source", "/app/src/routes/home.tsx", {
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
  it.each(["tsx", "ts", "jsx", "js", "mjs", "cts"])(
    "keeps the .%s parser extension last",
    (extension) => {
      const id = `/app/src/routes/home.${extension}?pracht-client`;
      expect(toPrachtClientPrefreshId(id)).toBe(`pracht-client:${id.length}:${id}.${extension}`);
    },
  );

  it("uses a namespace that cannot collide with a real sibling module", () => {
    const synthetic = toPrachtClientPrefreshId("/app/src/routes/home.tsx?pracht-client");

    expect(synthetic).not.toBe("/app/src/routes/home.pracht-client.tsx");
    expect(synthetic.startsWith("pracht-client:")).toBe(true);
  });

  // The complete remaining query participates in the key without lossy
  // character folding, so distinct Vite module instances stay distinct.
  it("keeps remaining queries collision-free", () => {
    const slash = "/app/src/routes/home.tsx?pracht-client&used=a/b";
    const underscore = "/app/src/routes/home.tsx?pracht-client&used=a_b";

    expect(toPrachtClientPrefreshId(slash)).not.toBe(toPrachtClientPrefreshId(underscore));
  });

  it("never collides with the authored file's own id", () => {
    expect(toPrachtClientPrefreshId("/app/src/routes/home.tsx?pracht-client")).not.toBe(
      "/app/src/routes/home.tsx",
    );
  });

  // Companion plugins compile these formats before pracht's post transforms;
  // the synthetic extension lets prefresh parse the resulting JavaScript.
  it("gives compiled formats a synthetic JSX extension", () => {
    for (const id of [
      "/app/src/routes/post.md?pracht-client",
      "/app/src/routes/post.mdx?pracht-client&used=1",
      "/app/src/routes/post.tsrx",
    ]) {
      expect(toPrachtClientPrefreshId(id)).toBe(`pracht-client:${id.length}:${id}.jsx`);
    }
  });
});
