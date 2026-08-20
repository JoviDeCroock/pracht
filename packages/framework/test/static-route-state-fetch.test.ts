import { describe, expect, it, vi } from "vitest";

import { defineApp, resolveApp, route } from "../src/index.ts";
import type { ResolvedRoute } from "../src/types.ts";

function resolvedRoute(path: string, meta: Record<string, unknown> = {}): ResolvedRoute {
  const app = resolveApp(
    defineApp({ routes: [route(path, "./routes/probe.tsx", { id: "probe", ...meta })] }),
  );
  return app.routes[0];
}

/**
 * `IS_STATIC_TARGET` is a compile-time define, so each target is exercised
 * with its own module instance.
 */
async function loadRouteNeedsServerFetch(staticTarget: boolean) {
  vi.resetModules();
  vi.doMock("../src/runtime-static.ts", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/runtime-static.ts")>();
    return { ...actual, IS_STATIC_TARGET: staticTarget };
  });
  const mod = await import("../src/runtime-client-fetch.ts");
  return mod.routeNeedsServerFetch;
}

describe("routeNeedsServerFetch on a static export", () => {
  it("skips the fetch for a dynamic route the build enumerated no paths for", async () => {
    const routeNeedsServerFetch = await loadRouteNeedsServerFetch(true);

    // Head metadata (usually inherited from the shell) is what otherwise
    // forces the request for an otherwise loaderless SPA route.
    expect(
      routeNeedsServerFetch(
        resolvedRoute("/tags/:tag", {
          render: "spa",
          hasLoader: false,
          hasHead: true,
          hasStaticPaths: false,
        }),
      ),
    ).toBe(false);

    expect(
      routeNeedsServerFetch(
        resolvedRoute("/app/*", { render: "spa", hasHead: true, hasStaticPaths: false }),
      ),
    ).toBe(false);
  });

  it("still fetches for enumerated, static, and unscanned routes", async () => {
    const routeNeedsServerFetch = await loadRouteNeedsServerFetch(true);

    // getStaticPaths() enumerated paths, so those URLs do have a state file.
    expect(
      routeNeedsServerFetch(
        resolvedRoute("/tags/:tag", { render: "spa", hasHead: true, hasStaticPaths: true }),
      ),
    ).toBe(true);
    // No dynamic segments: the shell document (and its state) is prerendered.
    expect(
      routeNeedsServerFetch(
        resolvedRoute("/dashboard", { render: "spa", hasHead: true, hasStaticPaths: false }),
      ),
    ).toBe(true);
    // Hint absent — the scan never saw the module, so stay conservative.
    expect(
      routeNeedsServerFetch(resolvedRoute("/tags/:tag", { render: "spa", hasHead: true })),
    ).toBe(true);
  });

  it("leaves the loaderless, headless shortcut intact", async () => {
    const routeNeedsServerFetch = await loadRouteNeedsServerFetch(true);

    expect(
      routeNeedsServerFetch(
        resolvedRoute("/tags/:tag", {
          render: "spa",
          hasLoader: false,
          hasHead: false,
          hasStaticPaths: true,
        }),
      ),
    ).toBe(false);
  });
});

describe("routeNeedsServerFetch on a serverful adapter", () => {
  it("ignores getStaticPaths — a server answers route state for any URL", async () => {
    const routeNeedsServerFetch = await loadRouteNeedsServerFetch(false);

    expect(
      routeNeedsServerFetch(
        resolvedRoute("/tags/:tag", { render: "ssr", hasHead: true, hasStaticPaths: false }),
      ),
    ).toBe(true);
  });
});
