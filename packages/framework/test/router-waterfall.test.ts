// @vitest-environment jsdom
/**
 * Scheduling and retention for a client navigation.
 *
 * A navigation needs three things before it can show the destination: the
 * route state, the route chunk and the shell chunk. Two properties are pinned
 * here, each with promises the test controls rather than with timing:
 *
 * - **Scheduling**: all three start together. No timer, threshold or warm
 *   cache is involved: a start is observed while the others are still pending.
 * - **Retention**: the page on screen stays until the last of them resolves.
 *   One of them resolving is never proof the destination is ready.
 */
import { h, type ComponentChildren } from "preact";
import { afterEach, describe, expect, it } from "vitest";

import { defineApp, resolveApp, route } from "../src/app.ts";
import { lazy, Suspense } from "../src/suspense.ts";
import { getNavigation, subscribeToNavigation } from "../src/navigation-state.ts";
import { prefetch } from "../src/prefetch-api.ts";
import { buildRouteStateUrl } from "../src/runtime-client-fetch.ts";
import { useNavigation } from "../src/runtime-hooks.ts";
import {
  createDeferred,
  mountRouter,
  reply,
  settle,
  teardownRouterHarness,
  type MountOptions,
  type StateReply,
} from "./router-harness.ts";

type Chunk = Record<string, unknown>;

const app = resolveApp(
  defineApp({
    shells: { main: "./shells/main.tsx", other: "./shells/other.tsx" },
    routes: [
      route("/", "./routes/home.tsx", { id: "home", render: "ssr", shell: "main" }),
      route("/a", "./routes/a.tsx", { id: "a", render: "ssr", shell: "other" }),
      route("/old", "./routes/old.tsx", { id: "old", render: "ssr", shell: "main" }),
      route("/panel", "./routes/panel.tsx", { id: "panel", render: "spa", shell: "main" }),
    ],
  }),
);

/** The shell on screen shows the pending navigation the way an app would. */
function MainShell({ children }: { children?: ComponentChildren }) {
  const navigation = useNavigation();
  return h(
    "div",
    { "data-shell": "main" },
    h("p", { id: "pending" }, navigation.state === "loading" ? "loading" : "idle"),
    children,
  );
}

const mainShell: Chunk = { Shell: MainShell };
const otherShell: Chunk = {
  Shell: ({ children }: { children?: ComponentChildren }) =>
    h("div", { "data-shell": "other" }, children),
};
const homeChunk: Chunk = { default: () => h("main", null, "home") };
const pageAChunk: Chunk = {
  default: ({ data }: { data: { title: string } }) => h("main", null, `page a: ${data.title}`),
};

const HOME_HTML = '<div data-shell="main"><p id="pending">idle</p><main>home</main></div>';

/** A chunk importer the test resolves by hand, counting how often it ran. */
function controlledChunk() {
  const deferred = createDeferred<Chunk>();
  const importer = Object.assign(
    () => {
      importer.starts++;
      return deferred.promise;
    },
    { starts: 0, resolve: deferred.resolve },
  );
  return importer;
}

function mountHome(options: Partial<MountOptions>) {
  return mountRouter({
    app,
    html: HOME_HTML,
    ...options,
    routeModules: { "./routes/home.tsx": async () => homeChunk, ...options.routeModules },
    shellModules: { "./shells/main.tsx": async () => mainShell, ...options.shellModules },
  });
}

/** How many route-state requests were sent for `path`. */
function requestsFor(fetched: readonly string[], path: string): number {
  return fetched.filter((url) => url === path).length;
}

function visiblePage(root: HTMLElement): string | undefined {
  return root.querySelector("main")?.textContent ?? undefined;
}

afterEach(() => {
  teardownRouterHarness();
});

describe("client navigation scheduling", () => {
  it("starts route state, the route chunk and the shell chunk together on a cold navigation", async () => {
    const stateA = createDeferred<StateReply>();
    const chunkA = controlledChunk();
    const shellOther = controlledChunk();
    const harness = await mountHome({
      routeModules: { "./routes/a.tsx": chunkA },
      shellModules: { "./shells/other.tsx": shellOther },
      state: { "/a": reply.deferred(stateA.promise) },
    });

    // Cold: nothing prefetched the destination, so no cache can hide a
    // waterfall behind an already-settled promise.
    expect(requestsFor(harness.fetched, "/a")).toBe(0);
    expect(chunkA.starts).toBe(0);
    expect(shellOther.starts).toBe(0);

    const navigation = window.__PRACHT_NAVIGATE__!("/a");

    // Read before anything is awaited: all three are in flight at once, and
    // none of them has resolved, so none started because another finished.
    expect(requestsFor(harness.fetched, "/a")).toBe(1);
    expect(chunkA.starts).toBe(1);
    expect(shellOther.starts).toBe(1);

    stateA.resolve(reply.data({ title: "loaded" }));
    chunkA.resolve(pageAChunk);
    shellOther.resolve(otherShell);
    await navigation;
    await settle();

    expect(visiblePage(harness.root)).toBe("page a: loaded");
    // Committing asked for nothing a second time.
    expect(requestsFor(harness.fetched, "/a")).toBe(1);
    expect(chunkA.starts).toBe(1);
    expect(shellOther.starts).toBe(1);
  });

  it("starts the destination's state and chunks together after following a loader redirect", async () => {
    const stateOld = createDeferred<StateReply>();
    const stateA = createDeferred<StateReply>();
    const chunkA = controlledChunk();
    const shellOther = controlledChunk();
    const harness = await mountHome({
      routeModules: {
        "./routes/old.tsx": async () => ({ default: () => h("main", null, "old") }),
        "./routes/a.tsx": chunkA,
      },
      shellModules: { "./shells/other.tsx": shellOther },
      state: {
        "/old": reply.deferred(stateOld.promise),
        "/a": reply.deferred(stateA.promise),
      },
    });
    const states: string[] = [];
    const unsubscribe = subscribeToNavigation((navigation) => states.push(navigation.state));

    const navigation = window.__PRACHT_NAVIGATE__!("/old");
    // The redirect is not known yet, so nothing of `/a` can have started.
    expect(chunkA.starts).toBe(0);

    stateOld.resolve(reply.redirect("/a"));
    await settle();

    // One hop later the same rule holds: state and both chunks are in flight
    // together, and the page being left is still the one on screen.
    expect(requestsFor(harness.fetched, "/a")).toBe(1);
    expect(chunkA.starts).toBe(1);
    expect(shellOther.starts).toBe(1);
    expect(visiblePage(harness.root)).toBe("home");
    expect(harness.root.querySelector("#pending")?.textContent).toBe("loading");
    expect(window.location.pathname).toBe("/");

    stateA.resolve(reply.data({ title: "after redirect" }));
    chunkA.resolve(pageAChunk);
    shellOther.resolve(otherShell);
    await navigation;
    await settle();
    unsubscribe();

    expect(visiblePage(harness.root)).toBe("page a: after redirect");
    expect(window.location.pathname).toBe("/a");
    // Pending never dropped to idle between the two hops.
    expect(states.filter((state) => state === "idle")).toHaveLength(1);
    expect(states.at(-1)).toBe("idle");
  });

  it("warms code and data in one prefetch, and the navigation reuses both", async () => {
    const stateA = createDeferred<StateReply>();
    const chunkA = controlledChunk();
    const shellOther = controlledChunk();
    const harness = await mountHome({
      routeModules: { "./routes/a.tsx": chunkA },
      shellModules: { "./shells/other.tsx": shellOther },
      state: { "/a": reply.deferred(stateA.promise) },
    });

    const prefetched = prefetch("/a");

    // One call starts the data request and both chunk imports.
    expect(requestsFor(harness.fetched, "/a")).toBe(1);
    expect(chunkA.starts).toBe(1);
    expect(shellOther.starts).toBe(1);

    // Clicking while the prefetch is still in flight joins it.
    const navigation = window.__PRACHT_NAVIGATE__!("/a");
    expect(requestsFor(harness.fetched, "/a")).toBe(1);
    expect(chunkA.starts).toBe(1);
    expect(shellOther.starts).toBe(1);

    stateA.resolve(reply.data({ title: "prefetched" }));
    chunkA.resolve(pageAChunk);
    shellOther.resolve(otherShell);
    await prefetched;
    await navigation;
    await settle();

    expect(visiblePage(harness.root)).toBe("page a: prefetched");
    expect(requestsFor(harness.fetched, "/a")).toBe(1);
    expect(chunkA.starts).toBe(1);
    expect(shellOther.starts).toBe(1);
  });
});

describe("client first-load scheduling", () => {
  it("starts the shell chunk without waiting for the route chunk", async () => {
    const chunkHome = controlledChunk();
    const shellMain = controlledChunk();
    const mounting = mountHome({
      routeModules: { "./routes/home.tsx": chunkHome },
      shellModules: { "./shells/main.tsx": shellMain },
    });
    await settle();

    // The route chunk has not resolved, so the shell import did not wait for it.
    expect(chunkHome.starts).toBe(1);
    expect(shellMain.starts).toBe(1);

    chunkHome.resolve(homeChunk);
    shellMain.resolve(mainShell);
    const harness = await mounting;
    expect(visiblePage(harness.root)).toBe("home");
    expect(document.documentElement.hasAttribute("data-pracht-hydrated")).toBe(true);
  });

  it("starts an SPA route's chunk while its route state is still loading", async () => {
    const statePanel = createDeferred<StateReply>();
    const chunkPanel = controlledChunk();
    const requested: string[] = [];
    const mounting = mountHome({
      url: "/panel",
      html: '<div data-shell="main"><p id="pending">idle</p></div>',
      initialState: { data: undefined, pending: true, routeId: "panel", url: "/panel" },
      routeModules: { "./routes/panel.tsx": chunkPanel },
      state: { "/panel": reply.deferred(statePanel.promise) },
      onFetch: (url) => {
        requested.push(url);
        return undefined;
      },
    });
    await settle();

    // The document was served without loader data. Neither its request nor
    // the route chunk has resolved, and both are in flight: whichever way
    // round they were sequenced, one of these would still be waiting.
    expect(requested).toEqual([buildRouteStateUrl("/panel")]);
    expect(chunkPanel.starts).toBe(1);

    statePanel.resolve(reply.data({ rows: 3 }));
    chunkPanel.resolve({
      default: ({ data }: { data: { rows: number } }) => h("main", null, `panel: ${data.rows}`),
    });
    const harness = await mounting;
    expect(visiblePage(harness.root)).toBe("panel: 3");
  });
});

describe("client navigation retention", () => {
  const parts = ["state", "route", "shell"] as const;
  type Part = (typeof parts)[number];
  const orders: Part[][] = [
    ["state", "route", "shell"],
    ["state", "shell", "route"],
    ["route", "state", "shell"],
    ["route", "shell", "state"],
    ["shell", "state", "route"],
    ["shell", "route", "state"],
  ];

  it.each(orders)(
    "keeps the current page until the last of %s → %s → %s resolves",
    async (...order) => {
      const stateA = createDeferred<StateReply>();
      const chunkA = controlledChunk();
      const shellOther = controlledChunk();
      const harness = await mountHome({
        routeModules: { "./routes/a.tsx": chunkA },
        shellModules: { "./shells/other.tsx": shellOther },
        state: { "/a": reply.deferred(stateA.promise) },
      });
      const historyLength = history.length;
      const resolvePart: Record<Part, () => void> = {
        state: () => stateA.resolve(reply.data({ title: "ready" })),
        route: () => chunkA.resolve(pageAChunk),
        shell: () => shellOther.resolve(otherShell),
      };

      const navigation = window.__PRACHT_NAVIGATE__!("/a");

      for (const part of order.slice(0, -1)) {
        resolvePart[part]();
        await settle();

        // Something resolved, but the destination is not ready: the page being
        // left is still on screen, says it is loading, and owns the URL.
        expect(visiblePage(harness.root)).toBe("home");
        expect(harness.root.querySelector("[data-shell]")?.getAttribute("data-shell")).toBe("main");
        expect(harness.root.querySelector("#pending")?.textContent).toBe("loading");
        expect(getNavigation()).toMatchObject({ state: "loading", location: { pathname: "/a" } });
        expect(window.location.pathname).toBe("/");
        expect(history.length).toBe(historyLength);
      }

      resolvePart[order.at(-1)!]();
      await navigation;
      await settle();

      expect(visiblePage(harness.root)).toBe("page a: ready");
      expect(harness.root.querySelector("[data-shell]")?.getAttribute("data-shell")).toBe("other");
      expect(getNavigation()).toEqual({ state: "idle" });
      expect(window.location.pathname).toBe("/a");
      expect(history.length).toBe(historyLength + 1);
      expect(harness.handoffs).toEqual([]);
    },
  );

  it("keeps a local boundary's fallback up while the content behind it suspends twice", async () => {
    // Secondary content the route deferred on purpose: its code, then its data.
    const code = createDeferred<{ default: () => ComponentChildren }>();
    const data = createDeferred<string>();
    let value: string | undefined;
    const reading = data.promise.then((resolved) => {
      value = resolved;
    });
    function Reviews() {
      if (value === undefined) throw reading;
      return h("section", { id: "reviews" }, value);
    }
    const LazyReviews = lazy(() => code.promise);

    const harness = await mountHome({
      routeModules: {
        "./routes/a.tsx": async () => ({
          default: ({ data: routeData }: { data: { title: string } }) =>
            h(
              "main",
              null,
              h("h1", null, routeData.title),
              h(Suspense, { fallback: h("p", { id: "fallback" }, "loading reviews") }, [
                h(LazyReviews, null),
              ]),
            ),
        }),
      },
      shellModules: { "./shells/other.tsx": async () => otherShell },
      state: { "/a": reply.data({ title: "Product" }) },
    });

    await harness.navigate("/a");

    // The critical part of the page committed with the navigation; only the
    // boundary is pending.
    const main = () => harness.root.querySelector("main")!;
    expect(main().querySelector("h1")?.textContent).toBe("Product");
    expect(main().querySelector("#fallback")).not.toBeNull();
    expect(getNavigation()).toEqual({ state: "idle" });

    // First suspension over (the code), second one begins (its data): the
    // fallback stays, and the rest of the page is untouched.
    code.resolve({ default: Reviews });
    await settle();
    expect(main().querySelector("h1")?.textContent).toBe("Product");
    expect(main().querySelector("#fallback")).not.toBeNull();
    expect(main().querySelector("#reviews")).toBeNull();

    data.resolve("12 reviews");
    await settle();
    expect(main().querySelector("#fallback")).toBeNull();
    expect(main().querySelector("#reviews")?.textContent).toBe("12 reviews");
    expect(main().querySelector("h1")?.textContent).toBe("Product");
  });
});
