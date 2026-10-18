import { EventEmitter } from "node:events";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

import { createClientDisconnectSignal, createWebRequest } from "../src/node-request.ts";

/**
 * Node emits `close` on both the request and the response for a completed
 * exchange *and* for an abandoned one; `res.writableFinished` is what separates
 * them. These fakes reproduce exactly that pair.
 */
function fakeExchange(): {
  req: IncomingMessage;
  res: ServerResponse & { writableFinished: boolean };
  finish: () => void;
  disconnect: () => void;
} {
  const req = new EventEmitter() as unknown as IncomingMessage;
  const res = Object.assign(new EventEmitter(), {
    writableFinished: false,
  }) as unknown as ServerResponse & { writableFinished: boolean };

  return {
    req,
    res,
    finish: () => {
      res.writableFinished = true;
      res.emit("close");
      (req as unknown as EventEmitter).emit("close");
    },
    disconnect: () => {
      res.emit("close");
      (req as unknown as EventEmitter).emit("close");
    },
  };
}

describe("createClientDisconnectSignal", () => {
  it("aborts when the socket closes before the response finished", () => {
    const { req, res, disconnect } = fakeExchange();
    const signal = createClientDisconnectSignal(req, res);

    expect(signal.aborted).toBe(false);
    disconnect();

    expect(signal.aborted).toBe(true);
    expect((signal.reason as Error).name).toBe("AbortError");
  });

  it("does not abort a request the server answered in full", () => {
    const { req, res, finish } = fakeExchange();
    const signal = createClientDisconnectSignal(req, res);

    finish();

    // Node closes both streams on every successful exchange too; aborting here
    // would fire the signal on every request the adapter served.
    expect(signal.aborted).toBe(false);
  });

  it("aborts once when the request stream closes before the response exists", () => {
    const { req, res } = fakeExchange();
    const signal = createClientDisconnectSignal(req, res);
    const reasons: unknown[] = [];
    signal.addEventListener("abort", () => reasons.push(signal.reason));

    (req as unknown as EventEmitter).emit("close");
    res.emit("close");

    expect(reasons).toHaveLength(1);
  });
});

describe("createClientDisconnectSignal over a real socket", () => {
  it("stays un-aborted after a POST body is fully read and the response is pending", async () => {
    let observed: boolean | undefined;
    const server = createServer(async (req, res) => {
      const signal = createClientDisconnectSignal(req, res);
      const request = await createWebRequest(req, { trustProxy: false, signal });
      await request.text();
      await new Promise((resolve) => setTimeout(resolve, 20));
      observed = request.signal.aborted;
      res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hello: "world" }),
      });
      expect(await response.text()).toBe("ok");
      expect(observed).toBe(false);
    } finally {
      server.close();
    }
  });

  it("aborts when the client hangs up while the app is still working", async () => {
    let resolveAborted!: (value: boolean) => void;
    const aborted = new Promise<boolean>((resolve) => (resolveAborted = resolve));
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => (resolveReady = resolve));
    const server = createServer(async (req, res) => {
      const signal = createClientDisconnectSignal(req, res);
      const request = await createWebRequest(req, { trustProxy: false, signal });
      await request.text();
      request.signal.addEventListener("abort", () => resolveAborted(true));
      setTimeout(() => resolveAborted(request.signal.aborted), 2000);
      resolveReady();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const client = httpRequest({ port, host: "127.0.0.1", method: "POST", path: "/" });
      client.on("error", () => {});
      client.end("{}");
      await ready;
      client.destroy();
      expect(await aborted).toBe(true);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

describe("createWebRequest", () => {
  it("puts the disconnect signal on the Request the runtime receives", async () => {
    const { req, res, disconnect } = fakeExchange();
    Object.assign(req, {
      method: "GET",
      url: "/dashboard",
      headers: { host: "example.com" },
      socket: {},
    });
    const signal = createClientDisconnectSignal(req, res);

    const request = await createWebRequest(req, { trustProxy: false, signal });

    // Without this the flagship adapter hands loaders a signal that can only
    // ever fire on the server-side timeout.
    expect(request.signal.aborted).toBe(false);
    disconnect();
    expect(request.signal.aborted).toBe(true);
  });

  it("still builds a request when no signal is supplied", async () => {
    const req = Object.assign(new EventEmitter(), {
      method: "GET",
      url: "/",
      headers: { host: "example.com" },
      socket: {},
    }) as unknown as IncomingMessage;

    const request = await createWebRequest(req, { trustProxy: false });

    expect(request.url).toBe("http://example.com/");
    expect(request.signal.aborted).toBe(false);
  });
});
