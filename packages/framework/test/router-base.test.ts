// @vitest-environment jsdom
import { h, render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Serialized route-state URLs are browser URLs: they carry the deploy base,
 * the same shape a client-side navigation commits. A prerendered document
 * whose URL disagreed with `window.location` would look outside the base to
 * the router, which then skips the post-hydration step that publishes the
 * visitor's query parameters.
 */
async function loadRouterUnderBase(base: string) {
  vi.resetModules();
  vi.stubEnv("BASE_URL", base);
  const [core, hydration] = await Promise.all([
    import("../src/index.ts"),
    import("../src/hydration.ts"),
  ]);
  hydration._resetForTesting();
  return core;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await Promise.resolve();
}

describe("client router under a deploy base", () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    root = document.createElement("div");
    document.body.appendChild(root);
    history.replaceState(null, "", "/");
    window.scrollTo = vi.fn();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    render(null, root);
    root.remove();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    delete window.__PRACHT_NAVIGATE__;
    delete window.__PRACHT_ROUTER_READY__;
  });

  it("publishes the visitor query after hydrating a prerendered document", async () => {
    const { defineApp, initClientRouter, resolveApp, route, useLocation, useSearchParams } =
      await loadRouterUnderBase("/my-project/");
    history.replaceState(null, "", "/my-project/products?lang=zh");
    const observedPaths: string[] = [];

    function Products({ data }: { data: { label: string } }) {
      const language = useSearchParams().get("lang");
      observedPaths.push(useLocation().pathname);
      return h("main", null, `${data.label}: ${language ?? "en"}`);
    }

    const app = resolveApp(
      defineApp({
        routes: [route("/products", "./routes/products.tsx", { id: "products", render: "ssg" })],
      }),
    );
    root.innerHTML = "<main>prerendered: en</main>";

    await initClientRouter({
      app,
      routeModules: { "./routes/products.tsx": async () => ({ default: Products }) },
      shellModules: {},
      // The prerender request carried the base, so the serialized URL does too.
      initialState: {
        data: { label: "prerendered" },
        routeId: "products",
        url: "/my-project/products",
      },
      root,
      findModuleKey: (_modules: unknown, file: string) => file,
    });

    await flush();
    expect(root.textContent).toBe("prerendered: zh");
    // useLocation() reports the URL the visitor is at, base included — the
    // same value a client-side navigation to this route commits.
    expect(observedPaths.at(-1)).toBe("/my-project/products");
  });

  it("resolves typed links against the base", async () => {
    const { buildHref, defineApp, resolveApp, route } = await loadRouterUnderBase("/my-project/");
    const app = resolveApp(
      defineApp({ routes: [route("/posts/:slug", "./routes/post.tsx", { id: "post" })] }),
    );

    expect(buildHref(app.routes, "post", { params: { slug: "hello" } })).toBe(
      "/my-project/posts/hello",
    );
  });
});
