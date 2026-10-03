// @vitest-environment jsdom
/**
 * The browser half of rich loader data: every place the client reads loader
 * data revives the route-data encoding when the app opted in. The server half
 * is route-data-transport.test.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// `pracht({ client: { richData: true } })` sets this define in both bundles.
// Hoisted above the imports: the runtime reads it once, at module load.
vi.hoisted(() => {
  (globalThis as { __PRACHT_RICH_DATA__?: boolean }).__PRACHT_RICH_DATA__ = true;
});

import { DEFER_RUNTIME_SHIM, resolveDeferredData, serializeDeferred, defer } from "../src/defer.ts";
import { encodeRouteData } from "../src/route-data-codec.ts";
import { fetchPrachtRouteState } from "../src/runtime-client-fetch.ts";
import { HYDRATION_STATE_ELEMENT_ID } from "../src/runtime-constants.ts";
import { readHydrationState } from "../src/runtime-context.ts";
import { buildHtmlDocument } from "../src/runtime-html.ts";
import type { PrachtHydrationState } from "../src/runtime-hooks.ts";

function richValue() {
  const author = { name: "Ada" };
  return {
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
    tags: new Set(["a"]),
    counts: new Map([["</script>", 1n]]),
    author,
    editor: author,
  };
}
type RichValue = ReturnType<typeof richValue>;

function expectRich(data: RichValue) {
  expect(data.createdAt).toBeInstanceOf(Date);
  expect(data.createdAt.toISOString()).toBe("2026-01-02T00:00:00.000Z");
  expect(data.tags).toEqual(new Set(["a"]));
  expect(data.counts.get("</script>")).toBe(1n);
  expect(data.author).toBe(data.editor);
}

/** Serialize through the real document builder and parse it as a browser would. */
function plantHydrationScript(state: PrachtHydrationState): void {
  const html = buildHtmlDocument({ head: {}, body: "<div id=app></div>", hydrationState: state });
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const script = parsed.getElementById(HYDRATION_STATE_ELEMENT_ID)!;
  document.head.appendChild(document.importNode(script, true));
}

afterEach(() => {
  document.head.innerHTML = "";
  delete window.__PRACHT_STATE__;
  delete (window as { __PRACHT_DEFER__?: unknown }).__PRACHT_DEFER__;
  vi.unstubAllGlobals();
});

describe("rich loader data in the browser", () => {
  it("revives the hydration state", () => {
    plantHydrationScript({ url: "/", routeId: "home", data: richValue(), error: null });
    expectRich(readHydrationState<RichValue>()!.data);
  });

  it("revives route-state responses", async () => {
    const body = JSON.stringify({ data: encodeRouteData(richValue()) });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { headers: { "content-type": "application/json" } })),
    );

    const result = await fetchPrachtRouteState("/");
    expect(result.type).toBe("data");
    expectRich((result as { data: RichValue }).data);
  });

  it("revives shell data in the hydration state, and leaves it absent when absent", () => {
    // The server encodes shell data where the shell loader runs, so it
    // reaches the document already encoded.
    plantHydrationScript({
      url: "/",
      routeId: "home",
      data: { plain: true },
      shellData: encodeRouteData(richValue()),
      error: null,
    });
    const state = readHydrationState<{ plain: boolean }>()!;
    expect(state.data).toEqual({ plain: true });
    expectRich(state.shellData as RichValue);

    document.head.innerHTML = "";
    delete window.__PRACHT_STATE__;
    plantHydrationScript({ url: "/", routeId: "home", data: richValue(), error: null });
    expect("shellData" in readHydrationState()!).toBe(false);
  });

  it("revives shell data in route-state responses and route errors", async () => {
    const respond = (body: unknown, status = 200) =>
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(JSON.stringify(body), {
              status,
              headers: { "content-type": "application/json" },
            }),
        ),
      );

    respond({ data: { plain: true }, shellData: encodeRouteData(richValue()) });
    const result = await fetchPrachtRouteState("/");
    expect(result).toMatchObject({ type: "data", data: { plain: true } });
    expectRich((result as { shell: { data: RichValue } }).shell.data);

    respond(
      {
        error: { message: "Invalid search params", name: "Error", status: 400 },
        shellData: encodeRouteData(richValue()),
      },
      400,
    );
    const failed = await fetchPrachtRouteState("/?page=-1");
    expect(failed.type).toBe("error");
    expectRich((failed as { shell: { data: RichValue } }).shell.data);
  });

  it("revives streamed defer() values", async () => {
    const { data, pending } = serializeDeferred({ rich: defer(Promise.resolve(richValue())) });
    // The shim queues a chunk that lands before the registry installs.
    new Function(DEFER_RUNTIME_SHIM)();
    const encoded = JSON.parse(JSON.stringify(encodeRouteData(richValue())));
    (
      window as unknown as { __PRACHT_DEFER__: { r(id: string, value: unknown): void } }
    ).__PRACHT_DEFER__.r(pending[0].id, encoded);

    plantHydrationScript({
      url: "/",
      routeId: "home",
      data,
      deferred: pending.map(({ id, path }) => ({ id, path })),
      error: null,
    });
    const state = readHydrationState<{ rich: unknown }>()!;
    expectRich((await resolveDeferredData(state.data.rich)) as RichValue);
  });
});
