import { describe, expect, it } from "vitest";

import { defineApp, handlePrachtRequest, resolveApiRoutes, route } from "../src/index.ts";
import { isUpgradeRequest } from "../src/upgrade.ts";
import {
  isProtocolSwitchResponse,
  withDefaultSecurityHeaders,
  withRouteResponseHeaders,
} from "../src/runtime-headers.ts";

/**
 * Stand in for what a Cloudflare Durable Object hands back from a WebSocket
 * handshake. It cannot be built directly here: undici's Response constructor
 * rejects status 101, and `WebSocketPair` only exists inside workerd. Shadowing
 * the two properties the framework reads keeps `instanceof Response` true — the
 * middleware chain checks it — while reproducing the shape that matters.
 */
function createUpgradeResponse(): Response & { webSocket: unknown } {
  const response = new Response(null, { status: 204 });
  Object.defineProperty(response, "status", { value: 101 });
  Object.defineProperty(response, "webSocket", { value: { accept() {} } });
  return response as Response & { webSocket: unknown };
}

const routeStateOptions = { isRouteStateRequest: false };

describe("isUpgradeRequest", () => {
  it("matches a WebSocket handshake", () => {
    const request = new Request("http://localhost/api/ws", {
      headers: { connection: "Upgrade", upgrade: "websocket" },
    });
    expect(isUpgradeRequest(request)).toBe(true);
  });

  it("matches case-insensitively and inside a protocol list", () => {
    expect(
      isUpgradeRequest(new Request("http://localhost/", { headers: { upgrade: "WebSocket" } })),
    ).toBe(true);
    expect(
      isUpgradeRequest(
        new Request("http://localhost/", { headers: { upgrade: "h2c, websocket" } }),
      ),
    ).toBe(true);
  });

  it("rejects plain requests and non-websocket upgrades", () => {
    expect(isUpgradeRequest(new Request("http://localhost/"))).toBe(false);
    expect(
      isUpgradeRequest(new Request("http://localhost/", { headers: { upgrade: "h2c" } })),
    ).toBe(false);
    expect(
      isUpgradeRequest(new Request("http://localhost/", { headers: { upgrade: "websocket2" } })),
    ).toBe(false);
  });
});

describe("isProtocolSwitchResponse", () => {
  it("detects a 101 handshake", () => {
    expect(isProtocolSwitchResponse(createUpgradeResponse())).toBe(true);
  });

  it("detects a response carrying a webSocket handle whatever its status", () => {
    const response = new Response(null, { status: 200 });
    Object.defineProperty(response, "webSocket", { value: { accept() {} } });
    expect(isProtocolSwitchResponse(response)).toBe(true);
  });

  it("ignores a null webSocket property, as workerd exposes on every response", () => {
    // workerd defines a `webSocket` getter on Response.prototype that returns
    // null for ordinary responses — an `in` check would match all of them.
    const response = new Response("hello", { status: 200 });
    Object.defineProperty(response, "webSocket", { value: null });
    expect(isProtocolSwitchResponse(response)).toBe(false);
  });

  it.each([200, 204, 302, 404, 500])("treats %i as an ordinary response", (status) => {
    expect(isProtocolSwitchResponse(new Response(null, { status }))).toBe(false);
  });
});

describe("security-header wrappers on protocol switches", () => {
  it("returns the very same object from withDefaultSecurityHeaders", () => {
    const upgrade = createUpgradeResponse();
    expect(withDefaultSecurityHeaders(upgrade)).toBe(upgrade);
  });

  it("returns the very same object from withRouteResponseHeaders", () => {
    const upgrade = createUpgradeResponse();
    expect(withRouteResponseHeaders(upgrade, routeStateOptions)).toBe(upgrade);
  });

  it("still copies and stamps ordinary responses", () => {
    const response = new Response("ok", { status: 200 });
    const wrapped = withDefaultSecurityHeaders(response);
    expect(wrapped).not.toBe(response);
    expect(wrapped.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("handlePrachtRequest WebSocket upgrades", () => {
  const app = defineApp({ routes: [route("/", "./routes/home.tsx")] });
  const apiRoutes = resolveApiRoutes(["/src/api/ws.ts"]);

  function createRegistry(upgrade: Response) {
    return {
      apiModules: { "/src/api/ws.ts": async () => ({ GET: async () => upgrade }) },
    };
  }

  function createUpgradeRequest(): Request {
    return new Request("http://localhost/api/ws", {
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-fetch-site": "same-origin",
      },
    });
  }

  it("passes the handshake through by identity, webSocket handle intact", async () => {
    const upgrade = createUpgradeResponse();
    const response = await handlePrachtRequest({
      app,
      apiRoutes,
      registry: createRegistry(upgrade),
      request: createUpgradeRequest(),
    });

    // Identity is the assertion that matters: a copied response is exactly the
    // failure mode, and it loses the socket rather than erroring visibly.
    expect(response).toBe(upgrade);
    expect((response as { webSocket?: unknown }).webSocket).toBe(upgrade.webSocket);
    expect(response.status).toBe(101);
    expect(response.headers.get("x-content-type-options")).toBeNull();
  });

  it("passes the handshake through the API middleware chain unchanged", async () => {
    const upgrade = createUpgradeResponse();
    const response = await handlePrachtRequest({
      app: defineApp({
        api: { middleware: ["apiAuth"] },
        middleware: { apiAuth: "./middleware/api-auth.ts" },
        routes: [route("/", "./routes/home.tsx")],
      }),
      apiRoutes,
      registry: {
        apiModules: { "/src/api/ws.ts": async () => ({ GET: async () => upgrade }) },
        middlewareModules: {
          "./middleware/api-auth.ts": async () => ({
            middleware: async (_args, next) => next(),
          }),
        },
      },
      request: createUpgradeRequest(),
    });

    expect(response).toBe(upgrade);
  });

  it("does not turn the handshake into a 500", async () => {
    // Before protocol switches were passed through, reconstructing the
    // response threw a RangeError inside the API try block and surfaced as an
    // opaque 500 — the bug this guards against.
    const response = await handlePrachtRequest({
      app,
      apiRoutes,
      registry: createRegistry(createUpgradeResponse()),
      request: createUpgradeRequest(),
    });

    expect(response.status).not.toBe(500);
  });
});
