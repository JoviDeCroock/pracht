// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

describe("prefetching under a deploy base", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    history.replaceState(null, "", "/");
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("resolves relative anchors against the current document URL", async () => {
    vi.stubEnv("BASE_URL", "/my-project/");
    vi.resetModules();
    history.replaceState(null, "", "/my-project/");
    const [{ defineApp, resolveApp, route }, { setupPrefetching }] = await Promise.all([
      import("../src/app.ts"),
      import("../src/prefetch.ts"),
    ]);
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { ok: true } }), {
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const anchor = document.createElement("a");
    anchor.setAttribute("href", "pricing");
    anchor.setAttribute("data-pracht-prefetch", "render");
    document.body.appendChild(anchor);
    const app = resolveApp(
      defineApp({
        routes: [route("/pricing", "./routes/pricing.tsx", { id: "pricing", render: "ssr" })],
      }),
    );

    setupPrefetching(app);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe("/my-project/pricing");
  });
});
