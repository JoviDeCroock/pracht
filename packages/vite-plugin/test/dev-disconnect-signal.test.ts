import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

import { devDisconnectSignal } from "../src/plugin-dev-ssr.ts";

async function listen(
  handler: Parameters<typeof createServer>[1],
): Promise<{ port: number; close: () => void }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

describe("devDisconnectSignal", () => {
  it("stays un-aborted after the upload is read while the response is pending", async () => {
    let observed: boolean | undefined;
    const server = await listen(async (req, res) => {
      const signal = devDisconnectSignal(req, res)!;
      for await (const _chunk of req) void _chunk;
      await new Promise((resolve) => setTimeout(resolve, 20));
      observed = signal.aborted;
      res.end("ok");
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/`, {
        method: "POST",
        body: "{}",
      });
      expect(await response.text()).toBe("ok");
      expect(observed).toBe(false);
    } finally {
      server.close();
    }
  });

  it("aborts when the client disconnects before the response finished", async () => {
    let resolveAborted!: (value: boolean) => void;
    const aborted = new Promise<boolean>((resolve) => (resolveAborted = resolve));
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => (resolveReady = resolve));
    const server = await listen(async (req, res) => {
      const signal = devDisconnectSignal(req, res)!;
      for await (const _chunk of req) void _chunk;
      signal.addEventListener("abort", () => resolveAborted(true));
      setTimeout(() => resolveAborted(signal.aborted), 2000);
      resolveReady();
    });
    try {
      const client = httpRequest({
        port: server.port,
        host: "127.0.0.1",
        method: "POST",
        path: "/",
      });
      client.on("error", () => {});
      client.end("{}");
      await ready;
      client.destroy();
      expect(await aborted).toBe(true);
    } finally {
      server.close();
    }
  });
});
