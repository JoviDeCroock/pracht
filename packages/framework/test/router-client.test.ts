// @vitest-environment jsdom
import { h, render } from "preact";
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  defineApp,
  initClientRouter,
  resolveApp,
  route,
  useLocation,
  useRouteData,
} from "../src/index.ts";

function createJsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
    },
    ...init,
  });
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await Promise.resolve();
}

describe("initClientRouter", () => {
  let root: HTMLDivElement;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = "";
    root = document.createElement("div");
    document.body.appendChild(root);
    history.replaceState(null, "", "/");
    window.scrollTo = vi.fn();
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    render(null, root);
    root.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete window.__PRACHT_NAVIGATE__;
    delete window.__PRACHT_ROUTER_READY__;
  });

  it("renders shell-less SPA routes after the pending bootstrap fetch resolves", async () => {
    const app = resolveApp(
      defineApp({
        routes: [route("/settings", "./routes/settings.tsx", { render: "spa" })],
      }),
    );

    fetchSpy.mockResolvedValue(createJsonResponse({ data: { user: "Jovi" } }));

    await initClientRouter({
      app,
      routeModules: {
        "./routes/settings.tsx": async () => ({
          default: function Settings() {
            const data = useRouteData<{ user: string }>();
            return h("main", null, `Hello ${data.user}`);
          },
        }),
      },
      shellModules: {},
      initialState: {
        data: null,
        pending: true,
        routeId: "settings",
        url: "/settings",
      },
      root,
      findModuleKey: (_modules, file) => file,
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "/settings?_data=1",
      expect.objectContaining({
        headers: {},
        redirect: "manual",
      }),
    );
    expect(root.textContent).toContain("Hello Jovi");
  });

  it("preserves same-shell instances without exposing stale route data to useRouteData()", async () => {
    const renderLog: Array<{ label: string; pathname: string }> = [];
    let shellMountCount = 0;

    function SharedShell({ children }: { children: ComponentChildren }) {
      const [shellId] = useState(() => ++shellMountCount);
      return h("section", { "data-shell-id": String(shellId) }, children);
    }

    function Page() {
      const data = useRouteData<{ label: string }>();
      const { pathname } = useLocation();
      renderLog.push({ label: data.label, pathname });
      return h("div", { id: "page" }, data.label);
    }

    const app = resolveApp(
      defineApp({
        shells: {
          app: "./shells/app.tsx",
        },
        routes: [
          route("/", "./routes/home.tsx", { render: "ssr", shell: "app" }),
          route("/next", "./routes/next.tsx", { render: "ssr", shell: "app" }),
        ],
      }),
    );

    root.innerHTML = '<section data-shell-id="1"><div id="page">start</div></section>';
    history.replaceState(null, "", "/");

    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/next") {
        return createJsonResponse({ data: { label: "next" } });
      }

      throw new Error(`Unexpected fetch for ${url}`);
    });

    await initClientRouter({
      app,
      routeModules: {
        "./routes/home.tsx": async () => ({ default: Page }),
        "./routes/next.tsx": async () => ({ default: Page }),
      },
      shellModules: {
        "./shells/app.tsx": async () => ({ Shell: SharedShell }),
      },
      initialState: {
        data: { label: "start" },
        routeId: "home",
        url: "/",
      },
      root,
      findModuleKey: (_modules, file) => file,
    });

    renderLog.length = 0;
    await window.__PRACHT_NAVIGATE__!("/next");
    await flush();

    expect(root.textContent).toContain("next");
    expect(root.querySelector("section")?.getAttribute("data-shell-id")).toBe("1");
    expect(shellMountCount).toBe(1);
    expect(renderLog).not.toContainEqual({
      label: "start",
      pathname: "/next",
    });
  });
});
