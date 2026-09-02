import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { h } from "preact";
import type { ViteDevServer } from "vite";
import { describe, expect, it, vi } from "vitest";

import * as frameworkServer from "../../framework/src/server.ts";
import * as errorOverlay from "../../framework/src/error-overlay.ts";
import { defineApp, resolveApp, route } from "../../framework/src/app.ts";
import { createDevSSRMiddleware, shouldIncludeDevErrorStack } from "../src/plugin-dev-ssr.ts";
import { PRACHT_SERVER_MODULE_ID } from "../src/plugin-assets.ts";

function createRequest(url: string): IncomingMessage {
  return {
    headers: { accept: "text/html,application/xhtml+xml", host: "localhost" },
    method: "GET",
    url,
  } as unknown as IncomingMessage;
}

/**
 * A real `ServerResponse` is a writable stream, and the dev middleware pipes
 * non-HTML bodies into it. Build the fake on a `PassThrough` so the harness
 * exercises the same code path a browser does.
 */
function createResponse() {
  const headers: Record<string, string | string[]> = {};
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  const finished = new Promise<void>((resolve) => stream.on("end", () => resolve()));
  const res = Object.assign(stream, {
    getHeader: (name: string) => headers[name.toLowerCase()],
    getHeaderNames: () => Object.keys(headers),
    removeHeader: (name: string) => {
      delete headers[name.toLowerCase()];
    },
    setHeader(name: string, value: unknown) {
      headers[name.toLowerCase()] = Array.isArray(value) ? value.map(String) : String(value);
      return res;
    },
    statusCode: 200,
  }) as unknown as ServerResponse;

  return {
    finished,
    res,
    read() {
      return {
        body: Buffer.concat(chunks).toString("utf-8"),
        bytes: Buffer.concat(chunks),
        headers,
        statusCode: res.statusCode,
      };
    },
  };
}

async function render(
  routeModule: Record<string, unknown>,
  options: {
    request?: IncomingMessage;
    shellModule?: Record<string, unknown>;
    stageHeaders?: Record<string, string>;
  } = {},
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

  const logger = { error: vi.fn(), warn: vi.fn() };
  const server = {
    config: { base: "/", logger, root: "/tmp/pracht-overlay-test" },
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

  const { finished, read, res } = createResponse();
  for (const [name, value] of Object.entries(options.stageHeaders ?? {})) {
    res.setHeader(name, value);
  }
  // A response the middleware declines (a plain 404) falls through to Vite and
  // never ends, so waiting only on the stream would hang.
  let fellThrough = () => {};
  const fallthrough = new Promise<void>((resolve) => {
    fellThrough = resolve;
  });
  const next = vi.fn(() => fellThrough());
  await createDevSSRMiddleware(server)(options.request ?? createRequest("/boom"), res, next);
  await Promise.race([finished, fallthrough]);
  return { ...read(), logger, next };
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

  // Before this, a throwing loader produced a perfect browser overlay and
  // absolute silence in the terminal running `pracht dev`.
  it("logs one line per failure to the dev terminal", async () => {
    const state = await render({
      loader: () => {
        throw new Error("loader exploded");
      },
      Component: () => null,
    });

    expect(state.logger.error).toHaveBeenCalledTimes(1);
    const [line] = state.logger.error.mock.calls[0] as [string];
    expect(line).toContain("loader");
    expect(line).toContain('"boom"');
    expect(line).toContain("/boom");
    expect(line).toContain("loader exploded");
    // The overlay already prints the stack for a document navigation.
    expect(line).not.toContain("\n");
  });

  // A client-side navigation fetches route state; the browser shows its own
  // error and the terminal is the only place the developer can see the cause.
  it("logs a route-state failure that never reaches the overlay", async () => {
    const state = await render(
      {
        loader: () => {
          throw new Error("state exploded");
        },
        Component: () => null,
      },
      {
        request: {
          headers: {
            accept: "application/json",
            host: "localhost",
            "x-pracht-route-state-request": "1",
          },
          method: "GET",
          url: "/boom",
        } as unknown as IncomingMessage,
      },
    );

    expect(state.logger.error).toHaveBeenCalledTimes(1);
    expect((state.logger.error.mock.calls[0] as [string])[0]).toContain("state exploded");
  });

  // An app-owned ErrorBoundary renders the app's error UI, but the failure is
  // still a server-side failure the developer needs to see.
  it("logs exactly once when an ErrorBoundary owns the response", async () => {
    const state = await render({
      Component: () => {
        throw new Error("boundary exploded");
      },
      ErrorBoundary: ({ error }: { error: Error }) => h("p", null, error.message),
    });

    expect(state.logger.error).toHaveBeenCalledTimes(1);
  });

  // `throw notFound()` without a not-found page is a routing outcome; a thrown
  // redirect never reaches the error path at all.
  it("stays quiet for an expected not-found", async () => {
    const notFound = Object.assign(new Error("Not Found"), {
      name: "PrachtHttpError",
      status: 404,
    });
    const state = await render({
      loader: () => {
        throw notFound;
      },
      Component: () => null,
    });

    expect(state.logger.error).not.toHaveBeenCalled();
  });

  // Vite stages `server.headers` before this middleware runs, and the failure
  // can arrive after the abandoned response's headers were copied across. A
  // surviving content-length would truncate the overlay.
  it("drops headers staged for the response it replaces", async () => {
    const state = await render(
      {
        Component: () => {
          throw new Error("render exploded");
        },
      },
      { stageHeaders: { "content-length": "5", "x-abandoned": "1" } },
    );

    expect(state.statusCode).toBe(500);
    expect(state.headers["content-length"]).toBeUndefined();
    expect(state.headers["x-abandoned"]).toBeUndefined();
    expect(state.headers["content-type"]).toContain("text/html");
    expect(state.body).toContain("render exploded");
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

/**
 * The terminal line carries the stack only when the failure names no user
 * module. A route module that failed to compile, or a loader that threw, is
 * already located by the message and the overlay; repeating its trace on every
 * route-state poll buries everything else.
 */
describe("dev error stack attribution", () => {
  const root = "/work/app";

  function frameworkError() {
    const error = new Error("module runner disconnected");
    error.stack = [
      "Error: module runner disconnected",
      "    at ModuleRunner.import (/work/app/node_modules/vite/dist/node/runner.js:12:3)",
      "    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)",
    ].join("\n");
    return error;
  }

  function userSyntaxError() {
    // Vite and Rollup annotate a transform failure with the module it could
    // not compile; the error itself escapes before any route matched, so it
    // reaches the logger with no route context at all.
    const error = Object.assign(new Error("Unexpected token (4:2)"), {
      id: "/work/app/src/routes/home.tsx",
    });
    error.stack = [
      "Error: Unexpected token (4:2)",
      "    at parse (/work/app/node_modules/rollup/dist/es/shared/parseAst.js:24:1)",
    ].join("\n");
    return error;
  }

  it("keeps the stack for a failure that names no user module", () => {
    expect(shouldIncludeDevErrorStack({ error: frameworkError(), root })).toBe(true);
  });

  it("omits the stack for a route module the developer can already find", () => {
    expect(shouldIncludeDevErrorStack({ error: userSyntaxError(), root })).toBe(false);
    expect(
      shouldIncludeDevErrorStack({
        context: { phase: "loader", routeFile: "./routes/home.tsx" },
        error: new Error("loader exploded"),
        root,
      }),
    ).toBe(false);
  });

  it("attributes a failure whose stack points into project source", () => {
    const error = new Error("boom");
    error.stack = ["Error: boom", "    at loader (/work/app/src/server/data.ts:3:9)"].join("\n");
    expect(shouldIncludeDevErrorStack({ error, root })).toBe(false);

    const devUrlError = new Error("boom");
    devUrlError.stack = ["Error: boom", "    at Module (/src/routes/home.tsx:2:1)"].join("\n");
    expect(shouldIncludeDevErrorStack({ error: devUrlError, root })).toBe(false);
  });

  it("opts everything back in under DEBUG", () => {
    expect(shouldIncludeDevErrorStack({ debug: true, error: userSyntaxError(), root })).toBe(true);
  });
});
