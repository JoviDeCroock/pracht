import { createServer, type IncomingMessage } from "node:http";
import type { ViteDevServer } from "vite";
import { describe, expect, it, vi } from "vitest";

import { nodeAdapter } from "../../adapter-node/src/index.ts";
import {
  createDevConfigureServerTarget,
  isViteOwnedUpgrade,
  runDevConfigureServer,
} from "../src/plugin-dev-ssr.ts";

function upgradeRequest(protocol?: string): IncomingMessage {
  return {
    headers: protocol ? { "sec-websocket-protocol": protocol } : {},
  } as unknown as IncomingMessage;
}

/**
 * The Node adapter's `configureServerFrom` hook is where WebSocket servers are
 * attached. `pracht dev` used to skip it, so sockets worked in production only.
 */
describe("dev configureServerFrom", () => {
  it("runs the Node adapter's hook against the dev HTTP server", async () => {
    const adapter = nodeAdapter({ configureServerFrom: "/src/server/websockets.ts" });
    const httpServer = createServer();
    const configureServer = vi.fn(async (server: typeof httpServer) => {
      server.on("upgrade", onUpgrade);
    });
    const onUpgrade = vi.fn();
    const server = {
      config: { logger: { warn: vi.fn() } },
      httpServer,
      ssrLoadModule: vi.fn(async () => ({ configureServer })),
    } as unknown as ViteDevServer;

    await runDevConfigureServer(server, adapter.dev!.configureServerFrom!);

    expect(server.ssrLoadModule).toHaveBeenCalledWith("/src/server/websockets.ts");
    expect(configureServer).toHaveBeenCalledOnce();
    const socket = {};
    httpServer.emit("upgrade", upgradeRequest(), socket, Buffer.alloc(0));
    expect(onUpgrade).toHaveBeenCalledOnce();
    expect(onUpgrade.mock.calls[0]![1]).toBe(socket);
  });

  it("keeps Vite's HMR handshakes away from the app's upgrade listeners", () => {
    const httpServer = createServer();
    const target = createDevConfigureServerTarget(httpServer);
    const onUpgrade = vi.fn();
    const onceUpgrade = vi.fn();
    const onRequest = vi.fn();

    expect(target.on("upgrade", onUpgrade)).toBe(target);
    target.once("upgrade", onceUpgrade);
    target.on("request", onRequest);

    httpServer.emit("upgrade", upgradeRequest("vite-hmr"), {}, Buffer.alloc(0));
    httpServer.emit("upgrade", upgradeRequest("vite-ping"), {}, Buffer.alloc(0));
    expect(onUpgrade).not.toHaveBeenCalled();
    expect(onceUpgrade).not.toHaveBeenCalled();

    httpServer.emit("upgrade", upgradeRequest("chat"), {}, Buffer.alloc(0));
    httpServer.emit("upgrade", upgradeRequest(), {}, Buffer.alloc(0));
    expect(onUpgrade).toHaveBeenCalledTimes(2);
    expect(onceUpgrade).toHaveBeenCalledOnce();

    target.off("upgrade", onUpgrade);
    httpServer.emit("upgrade", upgradeRequest(), {}, Buffer.alloc(0));
    expect(onUpgrade).toHaveBeenCalledTimes(2);
    expect(httpServer.listenerCount("upgrade")).toBe(0);

    httpServer.emit("request", {}, {});
    expect(onRequest).toHaveBeenCalledOnce();
    expect(target.listening).toBe(false);
    expect(target.address()).toBeNull();
  });

  it("recognises only Vite's own socket protocols", () => {
    expect(isViteOwnedUpgrade(upgradeRequest("vite-hmr"))).toBe(true);
    expect(isViteOwnedUpgrade(upgradeRequest("vite-ping"))).toBe(true);
    expect(isViteOwnedUpgrade(upgradeRequest("graphql-ws"))).toBe(false);
    expect(isViteOwnedUpgrade(upgradeRequest())).toBe(false);
  });

  it("warns instead of failing in Vite middleware mode", async () => {
    const warn = vi.fn();
    const ssrLoadModule = vi.fn();
    await runDevConfigureServer(
      { config: { logger: { warn } }, httpServer: null, ssrLoadModule } as unknown as ViteDevServer,
      "/src/server/websockets.ts",
    );
    expect(ssrLoadModule).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("middleware mode"));
  });

  it("fails loudly when the module does not export configureServer", async () => {
    await expect(
      runDevConfigureServer(
        {
          config: { logger: { warn: vi.fn() } },
          httpServer: createServer(),
          ssrLoadModule: async () => ({}),
        } as unknown as ViteDevServer,
        "/src/server/websockets.ts",
      ),
    ).rejects.toThrow("must export a configureServer(server) function");
  });
});
