// @vitest-environment jsdom
import { h } from "preact";
import type { ComponentChildren } from "preact";
import { useEffect } from "preact/hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defineApp, initClientRouter, resolveApp, route } from "../src/index.ts";
import type { RootModule } from "../src/index.ts";
import { clearPrefetchCache } from "../src/prefetch-cache.ts";
import { setRootSnapshotHandler } from "../src/runtime-client-fetch.ts";

async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

function shell(id: string) {
  return async () => ({
    Shell: ({ children }: { children?: ComponentChildren }) => h("div", { id }, children),
  });
}

describe("app root in the client router", () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    root = document.createElement("div");
    // What the server rendered for "/": the root above shell "a".
    root.innerHTML =
      '<section data-root="client-root"><div id="shell-a"><main>a</main></div></section>';
    document.body.appendChild(root);
    window.scrollTo = vi.fn() as typeof window.scrollTo;
    history.replaceState(null, "", "/");
    clearPrefetchCache();
  });

  afterEach(() => {
    setRootSnapshotHandler(null);
    vi.unstubAllGlobals();
    delete window.__PRACHT_NAVIGATE__;
  });

  it("keeps one root across a shell change and hydrates every snapshot", async () => {
    let mounts = 0;
    const hydrated: unknown[] = [];
    const rootModule: RootModule<{ label: string }> = {
      setup: vi.fn(() => ({ label: "client-root" })),
      Root({ state, children }) {
        useEffect(() => {
          mounts++;
        }, []);
        return h("section", { "data-root": state.label }, children);
      },
      hydrate(_state, snapshot) {
        hydrated.push(snapshot);
      },
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ data: { page: "b" }, root: { from: "navigation" } }, { status: 200 }),
      ),
    );

    await initClientRouter({
      app: resolveApp(
        defineApp({
          shells: { a: "./shells/a.tsx", b: "./shells/b.tsx" },
          routes: [
            route("/", "./routes/a.tsx", { shell: "a", render: "ssr" }),
            route("/b", "./routes/b.tsx", { shell: "b", render: "ssr" }),
          ],
        }),
      ),
      routeModules: {
        "./routes/a.tsx": async () => ({ default: () => h("main", null, "a") }),
        "./routes/b.tsx": async () => ({ default: () => h("main", null, "b") }),
      },
      shellModules: { "./shells/a.tsx": shell("shell-a"), "./shells/b.tsx": shell("shell-b") },
      initialState: { data: null, routeId: "", url: "/", root: { from: "document" } },
      root,
      findModuleKey: (_modules, file) => file,
      rootModule,
    });
    await flush();

    expect(root.innerHTML).toBe(
      '<section data-root="client-root"><div id="shell-a"><main>a</main></div></section>',
    );
    expect(rootModule.setup).toHaveBeenCalledWith({ request: undefined, isServer: false });

    await window.__PRACHT_NAVIGATE__!("/b");
    await flush();

    expect(root.innerHTML).toBe(
      '<section data-root="client-root"><div id="shell-b"><main>b</main></div></section>',
    );
    expect(mounts).toBe(1);
    expect(rootModule.setup).toHaveBeenCalledTimes(1);
    expect(hydrated).toEqual([{ from: "document" }, { from: "navigation" }]);
  });
});
