import type { IncomingMessage, ServerResponse } from "node:http";
import { h } from "preact";
import type { ViteDevServer } from "vite";
import { describe, expect, it, vi } from "vitest";

import * as frameworkServer from "../../framework/src/server.ts";
import * as errorOverlay from "../../framework/src/error-overlay.ts";
import { defineApp, resolveApp, route } from "../../framework/src/app.ts";
import { createDevSSRMiddleware } from "../src/plugin-dev-ssr.ts";
import { PRACHT_SERVER_MODULE_ID } from "../src/plugin-assets.ts";

function createRequest(url: string): IncomingMessage {
  return {
    headers: { accept: "text/html,application/xhtml+xml", host: "localhost" },
    method: "GET",
    url,
  } as unknown as IncomingMessage;
}

function createResponse() {
  const headers: Record<string, string> = {};
  const state = { body: "", headers, statusCode: 0 };
  const res = {
    end(body?: unknown) {
      state.body = String(body ?? "");
      state.statusCode = res.statusCode;
    },
    setHeader(name: string, value: unknown) {
      headers[name.toLowerCase()] = String(value);
    },
    statusCode: 200,
  };
  return { res: res as unknown as ServerResponse, state };
}

async function render(
  routeModule: Record<string, unknown>,
  options: { shellModule?: Record<string, unknown> } = {},
) {
  const routeDefinition = options.shellModule
    ? route("/boom", {
        component: "./routes/boom.tsx",
        id: "boom",
        render: "ssr",
        shell: "plain",
      })
    : route("/boom", "./routes/boom.tsx", { id: "boom", render: "ssr" });
  const serverMod = {
    apiRoutes: [],
    islandsBootstrapRequired: false,
    registry: {
      routeModules: { "./routes/boom.tsx": async () => routeModule },
      shellModules: options.shellModule
        ? { "./shells/plain.tsx": async () => options.shellModule }
        : undefined,
    },
    resolvedApp: resolveApp(
      defineApp({
        routes: [routeDefinition],
        shells: options.shellModule ? { plain: "./shells/plain.tsx" } : undefined,
      }),
    ),
  };

  const server = {
    config: { base: "/", logger: { warn: vi.fn() }, root: "/tmp/pracht-overlay-test" },
    ssrFixStacktrace: () => {},
    ssrLoadModule: async (id: string) => {
      if (id === "@pracht/core/server") return frameworkServer;
      if (id === "@pracht/core/error-overlay") return errorOverlay;
      if (id === PRACHT_SERVER_MODULE_ID) return serverMod;
      throw new Error(`Unexpected ssrLoadModule id: ${id}`);
    },
    // The real transform injects the Vite client; the overlay must survive it.
    transformIndexHtml: async (_url: string, html: string) => html,
  } as unknown as ViteDevServer;

  const { res, state } = createResponse();
  await createDevSSRMiddleware(server)(createRequest("/boom"), res, vi.fn());
  return state;
}

describe("dev SSR error overlay", () => {
  it("replaces the runtime's plain-text render failure", async () => {
    const state = await render({
      Component: () => {
        throw new Error("render exploded");
      },
    });

    expect(state.statusCode).toBe(500);
    expect(state.headers["content-type"]).toContain("text/html");
    expect(state.body).toContain("pracht error");
    expect(state.body).toContain("render exploded");
    // The route metadata the runtime knows and a stack trace cannot recover.
    expect(state.body).toContain("boom");
    expect(state.headers["server-timing"]).toMatch(/render;dur=/);
  });

  // The runtime response this replaces carried them; dev must not become the
  // one surface that answers a 500 without them.
  it("keeps the framework's default security headers", async () => {
    const state = await render({
      Component: () => {
        throw new Error("render exploded");
      },
    });

    expect(state.headers["x-content-type-options"]).toBe("nosniff");
    expect(state.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(state.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  });

  // `throw undefined` and a bare `Promise.reject()` are real failures. Keying
  // the swap on `error !== undefined` would drop them back to plain text.
  it("renders the overlay for a thrown undefined", async () => {
    const state = await render({
      loader: () => {
        // eslint-disable-next-line no-throw-literal
        throw undefined;
      },
      Component: () => null,
    });

    expect(state.statusCode).toBe(500);
    expect(state.headers["content-type"]).toContain("text/html");
    expect(state.body).toContain("pracht error");
  });

  // An ErrorBoundary render is the app's own error UI, not a framework failure.
  it("leaves an ErrorBoundary render alone", async () => {
    const state = await render({
      Component: () => {
        throw new Error("render exploded");
      },
      ErrorBoundary: ({ error }: { error: Error }) => h("p", { id: "boundary" }, error.message),
    });

    expect(state.statusCode).toBe(500);
    expect(state.body).toContain('id="boundary"');
    expect(state.body).not.toContain("pracht error");
  });

  it("leaves an ErrorBoundary alone when shell headers override its content type", async () => {
    const state = await render(
      {
        Component: () => {
          throw new Error("render exploded");
        },
        ErrorBoundary: ({ error }: { error: Error }) => h("p", { id: "boundary" }, error.message),
      },
      {
        shellModule: {
          Shell: ({ children }: { children?: unknown }) => children,
          headers: () => ({ "content-type": "text/plain; charset=utf-8" }),
        },
      },
    );

    expect(state.statusCode).toBe(500);
    expect(state.headers["content-type"]).toContain("text/plain");
    expect(state.body).toContain('id="boundary"');
    expect(state.body).not.toContain("pracht error");
  });

  // `pracht dev` passes debugErrors unconditionally; the runtime ignores it
  // under NODE_ENV=production and so must the overlay, or dev in a container
  // that exports it would print the internals the body just withheld.
  it("does not render the overlay when the runtime redacts errors", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      const state = await render({
        Component: () => {
          throw new Error("render exploded");
        },
      });

      expect(state.headers["content-type"]).toContain("text/plain");
      expect(state.body).not.toContain("pracht error");
      expect(state.body).not.toContain("render exploded");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
