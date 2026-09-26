// @vitest-environment jsdom
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { h, render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseRouteSearch } from "../src/api-validation.ts";
import {
  defineApp,
  initClientRouter,
  Link,
  resolveApp,
  route,
  useSearch,
  type ErrorBoundaryProps,
} from "../src/index.ts";
import { _resetForTesting } from "../src/hydration.ts";

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await Promise.resolve();
}

// Coerces `page` to a positive integer with a default of 1.
const search: StandardSchemaV1<unknown, { page: number }> = {
  "~standard": {
    version: 1,
    vendor: "pracht-test",
    validate(value) {
      const raw = (value as { page?: string }).page;
      const page = raw === undefined ? 1 : Number(raw);
      return Number.isInteger(page) && page >= 1
        ? { value: { page } }
        : { issues: [{ message: "Expected a positive integer", path: ["page"] }] };
    },
  },
};

function Catalog() {
  const { page } = useSearch<{ page: number }>();
  return h(
    "main",
    null,
    h("span", { id: "page" }, `${typeof page}:${page}`),
    h(Link, { route: "catalog", search: { page: page + 1 }, id: "next" }, "Next"),
  );
}

function CatalogError({ error }: ErrorBoundaryProps) {
  return h("p", { id: "error" }, `${error.status}:${error.issues?.[0]?.path?.join(".")}`);
}

const routeModules = {
  "./routes/catalog.tsx": async () => ({ search, default: Catalog, ErrorBoundary: CatalogError }),
  "./routes/home.tsx": async () => ({
    default: () => h("main", null, h("span", { id: "raw" }, JSON.stringify(useSearch()))),
  }),
};

function createApp(render: "ssg" | "ssr") {
  // `hasLoader: false` keeps navigation off the network: the client parses the
  // query on its own, which is what a loaderless or SPA route relies on.
  return resolveApp(
    defineApp({
      routes: [
        route("/", "./routes/home.tsx", { id: "home", render, hasLoader: false, hasHead: false }),
        route("/catalog", "./routes/catalog.tsx", {
          id: "catalog",
          render,
          hasLoader: false,
          hasHead: false,
        }),
      ],
    }),
  );
}

describe("client search params", () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    _resetForTesting();
    document.body.innerHTML = "";
    root = document.createElement("div");
    document.body.appendChild(root);
    window.scrollTo = vi.fn();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    render(null, root);
    root.remove();
    vi.unstubAllGlobals();
    delete window.__PRACHT_NAVIGATE__;
    delete window.__PRACHT_ROUTER_READY__;
    delete globalThis.__PRACHT_ROUTE_DEFINITIONS__;
  });

  function start(url: string, options: { parseSearch?: typeof parseRouteSearch } = {}) {
    return initClientRouter({
      app: createApp("ssg"),
      routeModules,
      shellModules: {},
      initialState: { data: null, routeId: "catalog", url },
      root,
      findModuleKey: (_modules, file) => file,
      parseSearch: parseRouteSearch,
      ...options,
    });
  }

  it("hydrates a prerendered page with its defaults, then parses the visitor's query", async () => {
    history.replaceState(null, "", "/catalog?page=3");
    root.innerHTML =
      '<main><span id="page">number:1</span><a href="/catalog?page=2" id="next">Next</a></main>';

    const observed: unknown[] = [];
    const recordingModules = {
      ...routeModules,
      "./routes/catalog.tsx": async () => ({
        search,
        default: () => {
          observed.push(useSearch<{ page: number }>().page);
          return h(Catalog, null);
        },
      }),
    };
    await initClientRouter({
      app: createApp("ssg"),
      routeModules: recordingModules,
      shellModules: {},
      initialState: { data: null, routeId: "catalog", url: "/catalog" },
      root,
      findModuleKey: (_modules, file) => file,
      parseSearch: parseRouteSearch,
    });

    await flush();
    await flush();
    // The hydration render matches the prerendered HTML; the visitor's query
    // is published after it.
    expect(observed[0]).toBe(1);
    expect(root.querySelector("#page")?.textContent).toBe("number:3");
    expect(root.querySelector("#next")?.getAttribute("href")).toBe("/catalog?page=4");
    expect(document.getElementById("__pracht_hydration_mismatch__")).toBeNull();
  });

  it("swaps in the error boundary when the visitor's query is rejected after hydration", async () => {
    history.replaceState(null, "", "/catalog?page=nope");
    root.innerHTML =
      '<main><span id="page">number:1</span><a href="/catalog?page=2" id="next">Next</a></main>';

    await start("/catalog");
    await flush();
    await flush();
    expect(root.querySelector("#error")?.textContent).toBe("400:page");
  });

  it("parses typed link targets on client navigation", async () => {
    history.replaceState(null, "", "/catalog?page=1");
    root.innerHTML =
      '<main><span id="page">number:1</span><a href="/catalog?page=2" id="next">Next</a></main>';

    await start("/catalog?page=1");
    // Follow the href the typed <Link search> built. (Routers from earlier
    // tests keep their document click listeners, so a synthetic click would
    // be claimed by one of them.)
    const href = root.querySelector<HTMLAnchorElement>("#next")!.getAttribute("href")!;
    expect(href).toBe("/catalog?page=2");
    await window.__PRACHT_NAVIGATE__!(href);
    await flush();

    expect(window.location.search).toBe("?page=2");
    expect(root.querySelector("#page")?.textContent).toBe("number:2");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("renders the route error boundary for a rejected query on client navigation", async () => {
    history.replaceState(null, "", "/catalog?page=1");
    root.innerHTML =
      '<main><span id="page">number:1</span><a href="/catalog?page=2" id="next">Next</a></main>';

    await start("/catalog?page=1");
    await window.__PRACHT_NAVIGATE__!("/catalog?page=0");
    await flush();

    expect(root.querySelector("#error")?.textContent).toBe("400:page");
  });

  it("reads the raw query record on routes without a schema", async () => {
    history.replaceState(null, "", "/catalog?page=1");
    root.innerHTML =
      '<main><span id="page">number:1</span><a href="/catalog?page=2" id="next">Next</a></main>';

    await start("/catalog?page=1");
    await window.__PRACHT_NAVIGATE__!("/?tag=a&tag=b&q=x");
    await flush();

    expect(root.querySelector("#raw")?.textContent).toBe('{"tag":["a","b"],"q":"x"}');
  });

  it("leaves the schema alone when the client entry passes no parser", async () => {
    history.replaceState(null, "", "/catalog?page=5");
    root.innerHTML =
      '<main><span id="page">string:5</span><a href="/catalog?page=2" id="next">Next</a></main>';

    await start("/catalog?page=5", { parseSearch: undefined });
    await flush();

    // No app route exports a schema in this configuration, so the raw record
    // is all there is.
    expect(root.querySelector("#page")?.textContent).toBe("string:5");
  });
});
