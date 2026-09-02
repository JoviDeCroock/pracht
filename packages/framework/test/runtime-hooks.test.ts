// @vitest-environment jsdom
/**
 * Direct behavioural coverage for `src/runtime-hooks.ts`.
 *
 * The module is the framework's entire public browser surface — `<Form>`,
 * `useNavigation()`, `useRouteData()`, `useLocation()`, `useSearchParams()`,
 * `useBlocker()`, `readHydrationState()`, `startApp()` — and until this file
 * existed nothing imported it directly: it was reached through `index.ts` for a
 * slice of `<Form>` validation, and otherwise only asserted as HTML substrings
 * from e2e. Everything here asserts on observable DOM, store state, or the
 * requests that actually left, never on which internal function was called.
 */
import { h, render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CAPABILITY_EFFECT_HEADER,
  CAPABILITY_FORM_REDIRECT_HEADER,
  CAPABILITY_FORM_REQUEST_HEADER,
  CAPABILITY_SETTLED_EVENT,
  capabilityHttpPath,
} from "../../capabilities/src/index.ts";
import { _resetBlockerForTesting } from "../src/navigation-blocker.ts";
import {
  _resetNavigationForTesting,
  beginLoadingNavigation,
  createNavigationLocation,
  getNavigation,
  settleNavigation,
  type Navigation,
} from "../src/navigation-state.ts";
import { HYDRATION_STATE_ELEMENT_ID } from "../src/runtime-constants.ts";
import { buildHtmlDocument } from "../src/runtime-html.ts";
import {
  Form,
  readHydrationState,
  startApp,
  useBlocker,
  useLocation,
  useNavigation,
  useRouteData,
  useSearchParams,
  type Blocker,
  type Location,
  type PrachtHydrationState,
  type ReadonlyURLSearchParams,
} from "../src/runtime-hooks.ts";
import { PrachtRuntimeProvider } from "../src/runtime-context.ts";
import type { HttpCapabilityName } from "../src/types.ts";

/**
 * The revalidation runtime is dynamically imported by the capability branch of
 * `<Form>` so an app without capabilities never bundles it. Mocking it keeps
 * these tests to the submit pipeline: whether route data refreshes afterwards
 * is `runtime-capability-revalidate.ts`'s contract, covered by its own tests.
 */
const ensureCapabilityRevalidation = vi.fn();
vi.mock("../src/runtime-capability-revalidate.ts", () => ({
  ensureCapabilityRevalidation: () => ensureCapabilityRevalidation(),
}));

/**
 * `<Form capability>` only accepts names an app registered through
 * `pracht typegen`. These are framework tests, so they use names no app
 * registers and opt out of that check deliberately.
 */
const unregistered = (name: string) => name as HttpCapabilityName;

let root: HTMLDivElement;
let fetchSpy: ReturnType<typeof vi.fn>;

/** Let queued microtasks (and preact's render queue) drain. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Preact defers `useEffect` to after paint (`requestAnimationFrame`), so a
 * macrotask alone is not enough for the hooks here that subscribe from an
 * effect — `useNavigation()` and `useBlocker()` both do.
 */
function flushEffects(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

function submit(submitter?: HTMLElement): Promise<void> {
  const form = root.querySelector("form")!;
  form.dispatchEvent(
    submitter
      ? new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter })
      : new Event("submit", { bubbles: true, cancelable: true }),
  );
  return flush();
}

beforeEach(() => {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
  root = document.createElement("div");
  document.body.appendChild(root);
  fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  ensureCapabilityRevalidation.mockClear();
  _resetNavigationForTesting();
  _resetBlockerForTesting();
  delete window.__PRACHT_STATE__;
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  render(null, root);
  root.remove();
  delete window.__PRACHT_NAVIGATE__;
  _resetNavigationForTesting();
  _resetBlockerForTesting();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
}

describe("<Form> action submissions", () => {
  it("leaves a GET form to the browser's native submission", async () => {
    render(
      h(Form, { action: "/search", method: "get" }, h("input", { name: "q", value: "pracht" })),
      root,
    );

    const form = root.querySelector("form")!;
    const event = new Event("submit", { bubbles: true, cancelable: true });
    form.dispatchEvent(event);
    await flush();

    expect(fetchSpy).not.toHaveBeenCalled();
    // Not preventing the default is what lets the browser navigate.
    expect(event.defaultPrevented).toBe(false);
  });

  it("fetches a POST submission with the redirect handshake header and form fields", async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));

    render(
      h(Form, { action: "/api/items", method: "post" }, h("input", { name: "name", value: "Ada" })),
      root,
    );
    await submit();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("/api/items");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(init.headers).toEqual({ [CAPABILITY_FORM_REQUEST_HEADER]: "1" });
    expect((init.body as FormData).get("name")).toBe("Ada");
  });

  // A FormData body only produces a valid multipart request when the browser
  // picks the boundary, which it only does when no content-type is set.
  it("never sets content-type itself, so an enctype form keeps its boundary", async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));

    render(
      h(
        Form,
        { action: "/api/upload", method: "post", enctype: "multipart/form-data" },
        h("input", { name: "title", value: "poster" }),
      ),
      root,
    );

    expect(root.querySelector("form")!.enctype).toBe("multipart/form-data");

    await submit();

    const init = fetchSpy.mock.calls[0][1];
    expect(Object.keys(init.headers as Record<string, string>)).toEqual([
      CAPABILITY_FORM_REQUEST_HEADER,
    ]);
    expect(init.body).toBeInstanceOf(FormData);
  });

  it("honours a submit button's formmethod override", async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));

    render(
      h(
        Form,
        { action: "/api/items/1", method: "post" },
        h("button", { formmethod: "delete", name: "confirm", value: "yes" }, "Delete"),
      ),
      root,
    );
    await submit(root.querySelector("button")!);

    expect(fetchSpy.mock.calls[0][1].method).toBe("DELETE");
    expect((fetchSpy.mock.calls[0][1].body as FormData).get("confirm")).toBe("yes");
  });

  it("hands onResponse the raw Response object", async () => {
    const response = jsonResponse({ id: 7 }, { status: 201 });
    fetchSpy.mockResolvedValue(response);
    const seen: Response[] = [];

    render(
      h(Form, { action: "/api/items", method: "post", onResponse: (r) => seen.push(r) }),
      root,
    );
    await submit();

    expect(seen).toHaveLength(1);
    // Identity, not a copy: callers read headers and the (undisturbed) body.
    expect(seen[0]).toBe(response);
    await expect(seen[0].json()).resolves.toEqual({ id: 7 });
  });

  it("routes the redirect handshake header through the client router without calling onResponse", async () => {
    fetchSpy.mockResolvedValue(
      new Response(null, {
        status: 204,
        headers: { [CAPABILITY_FORM_REDIRECT_HEADER]: "/thanks" },
      }),
    );
    const navigate = vi.fn().mockResolvedValue(undefined);
    window.__PRACHT_NAVIGATE__ = navigate;
    const onResponse = vi.fn();

    render(h(Form, { action: "/api/items", method: "post", onResponse }), root);
    await submit();

    // One request total: the destination is the router's to load, not fetch's.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith("/thanks", {
      _reloadRouteState: true,
      replace: undefined,
    });
    // A redirect is not a response the caller can act on — it already left.
    expect(onResponse).not.toHaveBeenCalled();
  });

  it("publishes the in-flight submission through useNavigation() and settles it", async () => {
    let release!: (response: Response) => void;
    fetchSpy.mockReturnValue(
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );

    const seen: Navigation[] = [];
    function Status() {
      const navigation = useNavigation();
      seen.push(navigation);
      return h("output", null, navigation.state);
    }

    render(
      h("div", null, [
        h(Status, null),
        h(
          Form,
          { action: "/api/items", method: "post" },
          h("input", { name: "name", value: "Ada" }),
        ),
      ]),
      root,
    );
    await flushEffects();

    root
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();

    const pending = getNavigation();
    expect(pending.state).toBe("submitting");
    expect(pending.location?.pathname).toBe("/api/items");
    expect(pending.formData?.get("name")).toBe("Ada");
    expect(root.querySelector("output")!.textContent).toBe("submitting");

    release(new Response(null, { status: 204 }));
    await flush();

    expect(getNavigation()).toEqual({ state: "idle" });
    expect(root.querySelector("output")!.textContent).toBe("idle");
    expect(seen.map((n) => n.state)).toContain("submitting");
  });

  // The action branch has no catch around `fetch`, only a `finally`. The
  // navigation must still settle, and the rejection must still surface rather
  // than being swallowed into a silent no-op the caller cannot observe.
  it("settles the navigation and propagates the failure when fetch rejects", async () => {
    const failure = new Error("offline");
    fetchSpy.mockRejectedValue(failure);
    const onResponse = vi.fn();

    render(h(Form, { action: "/api/items", method: "post", onResponse }), root);

    const existing = process.listeners("unhandledRejection");
    process.removeAllListeners("unhandledRejection");
    const rejections: unknown[] = [];
    const capture = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", capture);
    try {
      await submit();
      await flush();
    } finally {
      process.off("unhandledRejection", capture);
      for (const listener of existing) {
        process.on("unhandledRejection", listener as (reason: unknown) => void);
      }
    }

    expect(rejections).toEqual([failure]);
    expect(getNavigation()).toEqual({ state: "idle" });
    expect(onResponse).not.toHaveBeenCalled();
  });
});

describe("<Form capability>", () => {
  it("posts to the capability's HTTP projection and reports the envelope", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ ok: true, data: { id: "a" } }));
    const results: unknown[] = [];

    render(
      h(
        Form,
        {
          capability: unregistered("items.create"),
          onCapabilityResult: (envelope) => results.push(envelope),
        },
        h("input", { name: "name", value: "Ada" }),
      ),
      root,
    );

    // Capability forms post without JavaScript too, so the markup carries the
    // endpoint and method the enhanced path also uses.
    const form = root.querySelector("form")!;
    expect(form.getAttribute("method")).toBe("post");
    expect(form.getAttribute("action")).toBe(capabilityHttpPath("items.create"));

    await submit();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][1].method).toBe("POST");
    expect(results).toEqual([{ ok: true, data: { id: "a" } }]);
    expect(ensureCapabilityRevalidation).toHaveBeenCalledTimes(1);
  });

  it("resets the form after a successful submission and keeps it after a failure", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ ok: true, data: {} }));

    render(
      h(Form, { capability: unregistered("items.create") }, h("input", { name: "name" })),
      root,
    );
    const input = root.querySelector("input")!;
    input.value = "typed";
    await submit();
    expect(input.value).toBe("");

    fetchSpy.mockResolvedValue(
      jsonResponse(
        { ok: false, error: { code: "invalid_input", message: "nope" } },
        { status: 400 },
      ),
    );
    input.value = "typed again";
    await submit();
    expect(input.value).toBe("typed again");
  });

  it("synthesises an invalid_response envelope for a non-JSON body", async () => {
    fetchSpy.mockResolvedValue(
      new Response("<html>gateway</html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      }),
    );
    const results: { ok: boolean; error?: { code: string } }[] = [];

    render(
      h(Form, {
        capability: unregistered("items.create"),
        onCapabilityResult: (envelope) => results.push(envelope as never),
      }),
      root,
    );
    await submit();

    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
    expect(results[0].error?.code).toBe("invalid_response");
  });

  it("synthesises a network_error envelope when fetch rejects, and still settles", async () => {
    fetchSpy.mockRejectedValue(new Error("offline"));
    const results: { ok: boolean; error?: { code: string; message: string } }[] = [];
    const settled = vi.fn();
    window.addEventListener(CAPABILITY_SETTLED_EVENT, settled, { once: true });

    render(
      h(Form, {
        capability: unregistered("items.create"),
        onCapabilityResult: (envelope) => results.push(envelope as never),
      }),
      root,
    );
    await submit();

    expect(results).toEqual([{ ok: false, error: { code: "network_error", message: "offline" } }]);
    expect(getNavigation()).toEqual({ state: "idle" });
    // No response, so no effect class to report.
    expect((settled.mock.calls[0][0] as CustomEvent).detail).toEqual({
      name: "items.create",
      ok: false,
      effect: null,
    });
  });

  it("reports the server's effect class so read-only calls skip revalidation", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({ ok: true, data: [] }, { headers: { [CAPABILITY_EFFECT_HEADER]: "read" } }),
    );
    const settled = vi.fn();
    window.addEventListener(CAPABILITY_SETTLED_EVENT, settled, { once: true });

    render(h(Form, { capability: unregistered("items.search") }), root);
    await submit();

    expect((settled.mock.calls[0][0] as CustomEvent).detail).toEqual({
      name: "items.search",
      ok: true,
      effect: "read",
    });
  });
});

describe("useNavigation()", () => {
  it("tracks a router navigation from loading back to idle", async () => {
    const seen: string[] = [];
    function Status() {
      const navigation = useNavigation();
      seen.push(navigation.state);
      return h("output", null, navigation.location?.href ?? navigation.state);
    }

    render(h(Status, null), root);
    await flushEffects();
    expect(root.querySelector("output")!.textContent).toBe("idle");

    const token = beginLoadingNavigation(createNavigationLocation("/dashboard?tab=usage"));
    await flush();
    expect(root.querySelector("output")!.textContent).toBe("/dashboard?tab=usage");

    settleNavigation(token);
    await flush();
    expect(root.querySelector("output")!.textContent).toBe("idle");
    expect(seen).toContain("loading");
  });

  it("picks up a navigation that started between render and effect", async () => {
    // The store is written before the subscribing effect runs, which is the
    // race the hook re-syncs for.
    beginLoadingNavigation(createNavigationLocation("/late"));

    function Status() {
      return h("output", null, useNavigation().state);
    }
    render(h(Status, null), root);
    await flushEffects();

    expect(root.querySelector("output")!.textContent).toBe("loading");
  });
});

describe("useRouteData()", () => {
  function readData(routeId?: string): unknown {
    let captured: unknown;
    function Consumer() {
      captured = routeId === undefined ? useRouteData() : useRouteData(routeId);
      return null;
    }
    render(
      h(PrachtRuntimeProvider, {
        children: h(Consumer, null),
        data: { user: "Ada" },
        routeId: "dashboard",
        url: "/dashboard",
      }),
      root,
    );
    return captured;
  }

  it("returns the active route's data with and without a route id", () => {
    expect(readData()).toEqual({ user: "Ada" });
    render(null, root);
    expect(readData("dashboard")).toEqual({ user: "Ada" });
  });

  it("returns undefined outside a provider", () => {
    let captured: unknown = "unset";
    function Consumer() {
      captured = useRouteData();
      return null;
    }
    render(h(Consumer, null), root);
    expect(captured).toBeUndefined();
  });

  it("throws rather than returning another route's data under the requested type", () => {
    expect(() => readData("settings")).toThrow(/settings/);
    expect(() => readData("settings")).toThrow(/dashboard/);
  });
});

describe("useLocation() and useSearchParams()", () => {
  function readLocation(url?: string): { location: Location; params: ReadonlyURLSearchParams } {
    let captured!: { location: Location; params: ReadonlyURLSearchParams };
    function Consumer() {
      captured = { location: useLocation(), params: useSearchParams() };
      return null;
    }
    render(
      url === undefined
        ? h(Consumer, null)
        : h(PrachtRuntimeProvider, {
            children: h(Consumer, null),
            data: null,
            routeId: "search",
            url,
          }),
      root,
    );
    return captured;
  }

  it("splits the provider's URL into pathname and search", () => {
    expect(readLocation("/search?q=pracht&tag=a&tag=b").location).toEqual({
      pathname: "/search",
      search: "?q=pracht&tag=a&tag=b",
    });
  });

  it("falls back to the browser location outside a provider", () => {
    window.history.replaceState(null, "", "/browser?only=1");
    expect(readLocation().location).toEqual({ pathname: "/browser", search: "?only=1" });
  });

  it("reads repeated and missing query parameters", () => {
    const { params } = readLocation("/search?q=pracht&tag=a&tag=b");
    expect(params.get("q")).toBe("pracht");
    expect(params.getAll("tag")).toEqual(["a", "b"]);
    expect(params.get("missing")).toBeNull();
  });

  it("refuses mutation so the URL stays the single source of truth", () => {
    const { params } = readLocation("/search?q=pracht");
    const mutable = params as unknown as URLSearchParams;
    expect(() => mutable.set("q", "other")).toThrow(TypeError);
    expect(() => mutable.append("q", "other")).toThrow(TypeError);
    expect(() => mutable.delete("q")).toThrow(TypeError);
    expect(() => mutable.sort()).toThrow(TypeError);
    expect(params.get("q")).toBe("pracht");
  });
});

describe("useBlocker()", () => {
  function renderBlocker(shouldBlock: boolean) {
    let blocker!: Blocker;
    function Guard() {
      blocker = useBlocker(shouldBlock);
      return h("output", null, blocker.state);
    }
    render(h(Guard, null), root);
    return () => blocker;
  }

  it("blocks a router navigation and resumes it on proceed()", async () => {
    const read = renderBlocker(true);
    await flushEffects();
    expect(read().state).toBe("unblocked");

    const retry = vi.fn();
    const blocked = window.__PRACHT_BLOCK_NAVIGATION__!("/edit", "/away", "push", retry);
    await flush();

    expect(blocked).toBe(true);
    expect(retry).not.toHaveBeenCalled();
    expect(root.querySelector("output")!.textContent).toBe("blocked");
    expect(read().location?.pathname).toBe("/away");

    read().proceed();
    await flush();
    expect(retry).toHaveBeenCalledTimes(1);
    expect(root.querySelector("output")!.textContent).toBe("proceeding");
  });

  it("lets the navigation through on reset() only after the guard says no again", async () => {
    const read = renderBlocker(true);
    await flushEffects();

    window.__PRACHT_BLOCK_NAVIGATION__!("/edit", "/away", "push", vi.fn());
    await flush();
    read().reset();
    await flush();

    expect(root.querySelector("output")!.textContent).toBe("unblocked");
    expect(read().location).toBeNull();
    // Still armed: reset abandons this navigation, it does not disarm the guard.
    expect(window.__PRACHT_BLOCK_NAVIGATION__!("/edit", "/away", "push", vi.fn())).toBe(true);
  });

  // A `<Form>` submission is a fetch, not a history navigation: the guard
  // exists to protect unsaved work, and submitting is how that work is saved.
  it("does not block a <Form> submission", async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));
    let blocker!: Blocker;
    function Page() {
      blocker = useBlocker(true);
      return h(
        Form,
        { action: "/api/items", method: "post" },
        h("input", { name: "name", value: "Ada" }),
      );
    }
    render(h(Page, null), root);
    await flushEffects();

    await submit();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(blocker.state).toBe("unblocked");
  });

  it("stops guarding once the component unmounts", async () => {
    renderBlocker(true);
    await flushEffects();
    render(null, root);
    await flushEffects();

    expect(window.__PRACHT_BLOCK_NAVIGATION__!("/edit", "/away", "push", vi.fn())).toBe(false);
  });
});

describe("readHydrationState() and startApp()", () => {
  /** Serialize through the real document builder and parse it as a browser would. */
  function plantHydrationScript(state: PrachtHydrationState): string {
    const html = buildHtmlDocument({ head: {}, body: "<div id=app></div>", hydrationState: state });
    const parsed = new DOMParser().parseFromString(html, "text/html");
    const script = parsed.getElementById(HYDRATION_STATE_ELEMENT_ID)!;
    document.head.appendChild(document.importNode(script, true));
    return html;
  }

  it("parses the payload the server actually emitted", () => {
    const state: PrachtHydrationState = {
      url: "/dashboard?tab=usage",
      routeId: "dashboard",
      data: { user: { name: "Ada" }, items: [1, 2, 3] },
      error: null,
    };
    plantHydrationScript(state);

    expect(readHydrationState()).toEqual(state);
  });

  it("survives content that would otherwise close the script element", () => {
    const hostile = "a</script><script>globalThis.pwned=1</script> <!--";
    const html = plantHydrationScript({
      url: "/",
      routeId: "home",
      data: { note: hostile },
      error: null,
    });

    // The serialized document must not contain a second, executable script.
    expect(html).not.toContain("</script><script>globalThis.pwned");
    expect(readHydrationState<{ note: string }>()?.data.note).toBe(hostile);
    expect((globalThis as Record<string, unknown>).pwned).toBeUndefined();
  });

  it("carries the SPA pending and fallback markers through", () => {
    plantHydrationScript({
      url: "/settings",
      routeId: "settings",
      data: null,
      error: null,
      pending: true,
      fallback: true,
    });

    const state = readHydrationState();
    expect(state?.pending).toBe(true);
    expect(state?.fallback).toBe(true);
    expect(state?.data).toBeNull();
  });

  it("memoizes onto window so a removed script keeps answering", () => {
    plantHydrationScript({ url: "/", routeId: "home", data: { n: 1 }, error: null });

    const first = readHydrationState();
    expect(window.__PRACHT_STATE__).toEqual(first);

    document.getElementById(HYDRATION_STATE_ELEMENT_ID)!.remove();
    expect(readHydrationState()).toBe(first);
  });

  it("returns undefined when the document carries no state script", () => {
    expect(readHydrationState()).toBeUndefined();
    expect(startApp()).toBeUndefined();
  });

  it("startApp() prefers explicit initialData over the serialized payload", () => {
    plantHydrationScript({ url: "/", routeId: "home", data: { from: "html" }, error: null });

    expect(startApp()).toEqual({ from: "html" });
    expect(startApp({ initialData: { from: "caller" } })).toEqual({ from: "caller" });
  });
});
