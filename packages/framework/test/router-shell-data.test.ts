// @vitest-environment jsdom
import { h, render } from "preact";
import type { ComponentChildren } from "preact";
import { useContext } from "preact/hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  defineApp,
  initClientRouter,
  PrachtRuntimeProvider,
  resolveApp,
  route,
  useShellData,
} from "../src/index.ts";
import { clearPrefetchCache } from "../src/prefetch-cache.ts";
import {
  getMountedRuntimes,
  RouteDataContext,
  type PrachtRuntimeValue,
} from "../src/runtime-context.ts";
import { SHELL_DATA_REQUEST_HEADER } from "../src/runtime-constants.ts";
import { setHeldShell } from "../src/runtime-client-fetch.ts";
import { revalidateRouteData } from "../src/runtime-revalidate.ts";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await Promise.resolve();
}

function claimOf(call: unknown[]): string | undefined {
  const init = call[1] as RequestInit | undefined;
  return (init?.headers as Record<string, string> | undefined)?.[SHELL_DATA_REQUEST_HEADER];
}

describe("useShellData", () => {
  let scratch: HTMLDivElement;

  beforeEach(() => {
    scratch = document.createElement("div");
    document.body.appendChild(scratch);
  });

  afterEach(() => {
    render(null, scratch);
    scratch.remove();
  });

  it("reads the active shell's data and refuses another shell's name", () => {
    let captured: unknown;
    let thrown: unknown;

    function Consumer({ name }: { name?: string }) {
      try {
        captured = name === undefined ? useShellData() : useShellData(name);
      } catch (error) {
        thrown = error;
      }
      return null;
    }

    const tree = (name?: string) =>
      h(PrachtRuntimeProvider, {
        children: h(Consumer, { name }),
        data: null,
        routeId: "dashboard",
        shell: "app",
        shellData: { user: "Ada" },
        url: "/dashboard",
      });

    render(tree("app"), scratch);
    expect(captured).toEqual({ user: "Ada" });

    render(tree("public"), scratch);
    expect(String(thrown)).toContain("public");
  });

  it("keeps revalidated shell data across route states of the same shell", async () => {
    const initial = { user: "Ada" };
    let runtime: PrachtRuntimeValue | undefined;

    function Consumer() {
      runtime = useContext(RouteDataContext);
      return h("span", null, (useShellData() as { user: string } | undefined)?.user);
    }

    const tree = (props: { shell: string; shellData: unknown; stateVersion: number }) =>
      h(PrachtRuntimeProvider, {
        children: h(Consumer, null) as ComponentChildren,
        data: null,
        routeId: "r",
        url: "/r",
        ...props,
      });

    render(tree({ shell: "app", shellData: initial, stateVersion: 1 }), scratch);
    runtime!.setData(null, { data: { user: "Grace" } });
    await flush();
    expect(scratch.textContent).toBe("Grace");

    // A navigation inside the shell hands back the same shell data reference.
    render(tree({ shell: "app", shellData: initial, stateVersion: 2 }), scratch);
    await flush();
    expect(scratch.textContent).toBe("Grace");

    // A different shell's data replaces it.
    render(tree({ shell: "public", shellData: { user: "Linus" }, stateVersion: 3 }), scratch);
    await flush();
    expect(scratch.textContent).toBe("Linus");
  });
});

describe("client router shell data", () => {
  let root: HTMLDivElement;
  let fetchSpy: ReturnType<typeof vi.fn>;

  function ShellView({ children }: { children: ComponentChildren }) {
    const shell = useShellData() as { user: string } | undefined;
    return h("div", null, h("nav", null, `user:${shell?.user ?? "none"}`), children);
  }

  async function initRouter() {
    const app = resolveApp(
      defineApp({
        shells: { app: "./shells/app.tsx", public: "./shells/public.tsx" },
        routes: [
          route("/a", "./routes/a.tsx", { id: "a", shell: "app", render: "ssr" }),
          route("/b", "./routes/b.tsx", { id: "b", shell: "app", render: "ssr" }),
          route("/c", "./routes/c.tsx", { id: "c", shell: "public", render: "ssr" }),
        ],
      }),
    );
    const page = (name: string) => async () => ({ default: () => h("main", null, name) });
    await initClientRouter({
      app,
      routeModules: {
        "./routes/a.tsx": page("a"),
        "./routes/b.tsx": page("b"),
        "./routes/c.tsx": page("c"),
      },
      shellModules: {
        "./shells/app.tsx": async () => ({ Shell: ShellView }),
        "./shells/public.tsx": async () => ({ Shell: ShellView }),
      },
      initialState: { data: null, routeId: "a", url: "/a", shellData: { user: "Ada" } },
      root,
      findModuleKey: (_modules, file) => file,
    });
    await flush();
  }

  beforeEach(() => {
    document.body.innerHTML = "";
    root = document.createElement("div");
    document.body.appendChild(root);
    history.replaceState(null, "", "/a");
    window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    clearPrefetchCache();
    setHeldShell(undefined);
  });

  afterEach(() => {
    render(null, root);
    root.remove();
    vi.unstubAllGlobals();
    delete window.__PRACHT_NAVIGATE__;
    delete window.__PRACHT_ROUTER_READY__;
    setHeldShell(undefined);
  });

  it("reuses shell data inside the shell and fetches it when the shell changes", async () => {
    await initRouter();
    expect(root.textContent).toContain("user:Ada");

    fetchSpy.mockResolvedValueOnce(json({ data: null }));
    await window.__PRACHT_NAVIGATE__!("/b");
    await flush();
    expect(claimOf(fetchSpy.mock.calls[0]!)).toBe("app");
    expect(root.textContent).toContain("user:Ada");
    expect(root.textContent).toContain("b");

    fetchSpy.mockResolvedValueOnce(json({ data: null, shellData: { user: "Linus" } }));
    await window.__PRACHT_NAVIGATE__!("/c");
    await flush();
    expect(claimOf(fetchSpy.mock.calls[1]!)).toBeUndefined();
    expect(root.textContent).toContain("user:Linus");

    fetchSpy.mockResolvedValueOnce(json({ data: null, shellData: { user: "Grace" } }));
    await window.__PRACHT_NAVIGATE__!("/a");
    await flush();
    expect(claimOf(fetchSpy.mock.calls[2]!)).toBeUndefined();
    expect(root.textContent).toContain("user:Grace");
  });

  it("refreshes shell data on revalidation", async () => {
    await initRouter();
    // Reach the mounted provider through the same path useRevalidate() takes.
    const runtime = [...getMountedRuntimes()].at(-1);

    fetchSpy.mockResolvedValueOnce(json({ data: null, shellData: { user: "Grace" } }));
    await revalidateRouteData(runtime);
    await flush();

    expect(claimOf(fetchSpy.mock.calls[0]!)).toBeUndefined();
    expect(root.textContent).toContain("user:Grace");

    // The revalidated value survives a navigation that stays in the shell.
    fetchSpy.mockResolvedValueOnce(json({ data: null }));
    await window.__PRACHT_NAVIGATE__!("/b");
    await flush();
    expect(root.textContent).toContain("user:Grace");
  });
});
