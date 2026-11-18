import type { Plugin } from "vite";
import { describe, expect, it, vi } from "vitest";

import { toPrachtClientPrefreshId } from "../src/client-module-query.ts";
import { createFastRefreshPlugin } from "../src/fast-refresh.ts";

/** The shape `@prefresh/vite` itself rejects: an id that is not a bare `.tsx`. */
const CLIENT_ROUTE_ID = "/app/src/routes/home.tsx?pracht-client";
const CLIENT_ROUTE_REFRESH_ID = `pracht-client:${CLIENT_ROUTE_ID.length}:${CLIENT_ROUTE_ID}.tsx`;

/** What reaches the plugin: JSX already compiled, server-only exports stripped. */
const COMPONENT_MODULE = `
import { useState } from "preact/hooks";
import { jsxDEV } from "preact/jsx-dev-runtime";
export function Component() {
  const [count] = useState(0);
  return jsxDEV("p", { children: count });
}
`;
const CONTEXT_MODULE = `
import { createContext } from "preact";
${COMPONENT_MODULE}
export const Theme = createContext("light");
`;

function setup(
  overrides: { wrapper?: unknown; context?: unknown; plugins?: unknown[] } = {},
  options: { isRouteOrShellModule?: (id: string) => boolean } = {},
) {
  const wrapper = vi.fn(async (code: string, id: string) => ({
    code: `/* wrapped ${id} */${code}`,
    map: null,
  }));
  const context = vi.fn(async (code: string, _id: string) => ({
    code: code.replace('createContext("light")', 'memoized("light")'),
    map: null,
  }));
  const load = vi.fn(
    async () =>
      (overrides.plugins ?? [
        { name: "prefresh-rolldown", transform: overrides.context ?? { handler: context } },
        { name: "prefresh-wrapper", transform: overrides.wrapper ?? { handler: wrapper } },
      ]) as Plugin[],
  );
  const plugin = createFastRefreshPlugin({ ...options, loadStagePlugins: load });
  return { plugin, wrapper, context, load };
}

function run(plugin: Plugin, code: string, id: string, ssr = false, self: object = {}) {
  return (plugin.transform as any).call(self, code, id, { ssr }) as Promise<any>;
}

function resolveConfig(plugin: Plugin, config: object) {
  (plugin.configResolved as (config: object) => void)(config);
}

describe("pracht:fast-refresh", () => {
  it("registers a pracht client route module's components and wraps it", async () => {
    const { plugin, wrapper, context } = setup();

    const result = await run(plugin, COMPONENT_MODULE, CLIENT_ROUTE_ID);

    // Satisfies prefresh's extension filter while staying distinct from the id
    // of the authored file, which can be in the client graph at the same time.
    expect(wrapper).toHaveBeenCalledTimes(1);
    const [registered, id] = wrapper.mock.calls[0];
    expect(id).toBe(CLIENT_ROUTE_REFRESH_ID);
    expect(registered).toContain('$RefreshReg$(_c, "Component")');
    expect(registered).toContain("$RefreshSig$()");
    expect(result.code).toBe(`/* wrapped ${CLIENT_ROUTE_REFRESH_ID} */${registered}`);
    expect(result.map).toBeTruthy();
    // No `createContext()` in the module, so nothing to keep stable.
    expect(context).not.toHaveBeenCalled();
  });

  it("refreshes a plain script module under its own id", async () => {
    const { plugin, wrapper } = setup();

    await run(plugin, COMPONENT_MODULE, "/app/src/components/Counter.tsx");

    expect(wrapper.mock.calls[0][1]).toBe("/app/src/components/Counter.tsx");
  });

  // Vite's own Oxc pass registers only JSX files; a hook in `.ts` would go
  // unsigned, and reordering its hooks would keep stale state.
  it("signs a custom hook in a .ts module", async () => {
    const { plugin, wrapper } = setup();
    const hook = `
import { useState } from "preact/hooks";
export function useTally() {
  const [tally] = useState(0);
  return tally;
}
`;

    await run(plugin, hook, "/app/src/lib/use-tally.ts");

    expect(wrapper.mock.calls[0][0]).toContain("$RefreshSig$()");
  });

  it("keeps createContext() identity before registering", async () => {
    const { plugin, wrapper, context } = setup();

    const result = await run(plugin, CONTEXT_MODULE, CLIENT_ROUTE_ID);

    expect(context).toHaveBeenCalledTimes(1);
    // The context stage sees the incoming code, not the registered code.
    expect(context.mock.calls[0][0]).toBe(CONTEXT_MODULE);
    expect(context.mock.calls[0][1]).toBe(CLIENT_ROUTE_REFRESH_ID);
    expect(wrapper.mock.calls[0][0]).toContain('memoized("light")');
    expect(result.code).toContain('memoized("light")');
  });

  it("keeps a context module with no components memoized but unwrapped", async () => {
    const { plugin, wrapper } = setup();
    const code =
      'import { createContext } from "preact";\nexport const Theme = createContext("light");\n';

    const result = await run(plugin, code, "/app/src/lib/theme.ts");

    expect(result.code).toContain('memoized("light")');
    expect(wrapper).not.toHaveBeenCalled();
  });

  it.each([
    ["a dependency", "/app/node_modules/ui-kit/index.jsx"],
    ["a worker", "/app/src/worker.ts?worker"],
    ["a stylesheet", "/app/src/styles.css"],
    ["a query other than pracht-client", "/app/src/x.tsx?raw"],
  ])("ignores %s", async (_name, id) => {
    const { plugin, wrapper, load } = setup();

    expect(await run(plugin, COMPONENT_MODULE, id)).toBeNull();
    expect(wrapper).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });

  it("transforms a bare compiled route format through a synthetic JSX id", async () => {
    const id = "/app/src/routes/home.tsrx";
    const { plugin, wrapper } = setup(
      {},
      { isRouteOrShellModule: (candidate) => candidate === id },
    );

    const result = await run(plugin, COMPONENT_MODULE, id);

    expect(wrapper.mock.calls[0][1]).toBe(`pracht-client:${id.length}:${id}.jsx`);
    expect(result.code).toContain("$RefreshReg$(");
  });

  it("compiles JSX a compiled format left behind", async () => {
    const { plugin, wrapper } = setup({}, { isRouteOrShellModule: () => true });

    await run(
      plugin,
      "export function Component() {\n  return <p>post</p>;\n}\n",
      "/app/src/routes/post.mdx",
    );

    const [registered] = wrapper.mock.calls[0];
    expect(registered).not.toContain("<p>");
    expect(registered).toContain('$RefreshReg$(_c, "Component")');
  });

  // The route copy of a file is `?pracht-client`; a bare copy is a sibling's
  // plain import and keeps its own id, so the two never share a key.
  it("refreshes a bare route module under its own id, not the synthetic one", async () => {
    const { plugin, wrapper } = setup({}, { isRouteOrShellModule: () => true });

    await run(plugin, COMPONENT_MODULE, "/app/src/routes/home.tsx");

    expect(wrapper.mock.calls[0][1]).toBe("/app/src/routes/home.tsx");
  });

  it("registers a component whose module mentions the refresh calls in a string", async () => {
    const { plugin, wrapper } = setup();
    const code = `const SNIPPET = "call $RefreshReg$(type, id)";\n${COMPONENT_MODULE}`;

    await run(plugin, code, CLIENT_ROUTE_ID);

    expect(wrapper.mock.calls[0][0]).toContain('$RefreshReg$(_c, "Component")');
  });

  it("does not wrap a module that only mentions the refresh calls in a string", async () => {
    const { plugin, wrapper } = setup();
    const code = 'export const SNIPPET = "call $RefreshReg$(type, id) and $RefreshSig$()";\n';

    expect(await run(plugin, code, CLIENT_ROUTE_ID)).toBeNull();
    expect(wrapper).not.toHaveBeenCalled();
  });

  it("leaves a module with no components alone", async () => {
    const { plugin, wrapper } = setup();

    expect(await run(plugin, "export const answer = 42;\n", CLIENT_ROUTE_ID)).toBeNull();
    expect(wrapper).not.toHaveBeenCalled();
  });

  // A module Vite can serve stays served, without Fast Refresh.
  it("leaves a module the registration pass cannot parse alone", async () => {
    const { plugin, wrapper } = setup();

    expect(await run(plugin, "const value: number = 1;\n", CLIENT_ROUTE_ID)).toBeNull();
    expect(wrapper).not.toHaveBeenCalled();
  });

  it("keeps the incoming code when the wrapper declines", async () => {
    const { plugin } = setup({ wrapper: { handler: vi.fn(async () => undefined) } });

    expect(await run(plugin, COMPONENT_MODULE, CLIENT_ROUTE_ID)).toBeNull();
  });

  // Without the HMR client nothing defines `$RefreshReg$`.
  it("does nothing when the resolved config has HMR off", async () => {
    const { plugin, wrapper, context, load } = setup();
    resolveConfig(plugin, { server: { hmr: false } });

    expect(await run(plugin, CONTEXT_MODULE, CLIENT_ROUTE_ID)).toBeNull();
    expect(load).not.toHaveBeenCalled();
    expect(wrapper).not.toHaveBeenCalled();
    expect(context).not.toHaveBeenCalled();
  });

  // The context stage turns itself off in production mode; refreshing without
  // it would detach a context's consumers from their provider on an edit.
  it("does nothing on a dev server running in production mode", async () => {
    const { plugin, wrapper, load } = setup();
    resolveConfig(plugin, { server: {}, isProduction: true });

    expect(await run(plugin, CONTEXT_MODULE, CLIENT_ROUTE_ID)).toBeNull();
    expect(load).not.toHaveBeenCalled();
    expect(wrapper).not.toHaveBeenCalled();
  });

  it("ignores SSR transforms", async () => {
    const { plugin, wrapper, load } = setup();

    expect(await run(plugin, COMPONENT_MODULE, CLIENT_ROUTE_ID, true)).toBeNull();
    expect(
      await run(plugin, COMPONENT_MODULE, CLIENT_ROUTE_ID, false, {
        environment: { config: { consumer: "server" } },
      }),
    ).toBeNull();
    expect(wrapper).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });

  it("never runs during a production build", () => {
    const { plugin } = setup();

    expect(plugin.apply).toBe("serve");
    // Ordering matters: the stages have to see the module with its server-only
    // exports already stripped by pracht:client-module-transform.
    expect(plugin.enforce).toBe("post");
  });

  it("loads @prefresh/vite once, on the first module that needs it", async () => {
    const { plugin, load } = setup();
    expect(load).not.toHaveBeenCalled();

    await run(plugin, COMPONENT_MODULE, CLIENT_ROUTE_ID);
    await run(plugin, COMPONENT_MODULE, "/app/src/components/Counter.tsx");

    expect(load).toHaveBeenCalledTimes(1);
  });

  // The stage plugins are not registered with Vite, so nothing else would
  // hand them the resolved config they enable themselves from.
  it("passes the resolved config on to the stage plugins", async () => {
    const configResolved = vi.fn();
    const config = { server: { hmr: true }, logger: { warn: vi.fn() } };
    const { plugin } = setup({
      plugins: [
        { name: "prefresh-rolldown", configResolved, transform: vi.fn(async () => undefined) },
        {
          name: "prefresh-wrapper",
          configResolved: { handler: configResolved },
          transform: vi.fn(async (code: string) => ({ code, map: null })),
        },
      ],
    });
    resolveConfig(plugin, config);

    await run(plugin, COMPONENT_MODULE, CLIENT_ROUTE_ID);

    expect(configResolved).toHaveBeenCalledTimes(2);
    expect(configResolved).toHaveBeenCalledWith(config);
  });

  it("supports the function form of the transform hooks", async () => {
    const wrapper = vi.fn(async (code: string) => ({ code: `/* wrapped */${code}`, map: null }));
    const context = vi.fn(async (code: string) => ({ code, map: null }));
    const { plugin } = setup({ wrapper, context });

    await run(plugin, CONTEXT_MODULE, CLIENT_ROUTE_ID);

    expect(context).toHaveBeenCalledTimes(1);
    expect(wrapper).toHaveBeenCalledTimes(1);
  });

  // Fast Refresh being unavailable is a valid configuration, not an error.
  it("does nothing when no prefresh wrapper is present", async () => {
    for (const plugins of [[], [{ name: "other" }], [{ name: "prefresh-rolldown" }], [null]]) {
      const { plugin } = setup({ plugins });
      expect(await run(plugin, COMPONENT_MODULE, CLIENT_ROUTE_ID)).toBeNull();
    }
  });

  it("warns once and serves modules unchanged when @prefresh/vite fails to load", async () => {
    const warn = vi.fn();
    const plugin = createFastRefreshPlugin({
      loadStagePlugins: () => Promise.reject(new Error("native binding missing")),
    });
    resolveConfig(plugin, { server: {}, logger: { warn } });

    expect(await run(plugin, COMPONENT_MODULE, CLIENT_ROUTE_ID)).toBeNull();
    expect(await run(plugin, COMPONENT_MODULE, "/app/src/components/Counter.tsx")).toBeNull();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("native binding missing");
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
