import { once } from "node:events";
import { createServer, request as httpRequest, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { createVercelNodeListener } from "../src/index.ts";

const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

async function listen(handler: (request: Request) => Response): Promise<number> {
  const listener = createVercelNodeListener(async (request) => handler(request));
  const server = createServer((req, res) => void listener(req, res));
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

// The Vercel bundle is shared with the edge function, so its Node writer is
// a web-globals-only copy of `@pracht/adapter-node/bridge`'s and is held to
// the same contract here.
describe("Vercel Node function response writer", () => {
  it("waits for drain instead of buffering the whole body", async () => {
    const chunk = new Uint8Array(256 * 1024).fill(98);
    const total = 32;
    let maxBuffered = 0;
    const port = await listen(() => {
      let sent = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent++ === total) controller.close();
            else controller.enqueue(chunk);
          },
        }),
      );
    });
    servers[0]!.on("request", (_req, res: ServerResponse) => {
      const write = res.write.bind(res) as (chunk: Uint8Array) => boolean;
      res.write = ((value: Uint8Array) => {
        const ok = write(value);
        maxBuffered = Math.max(maxBuffered, res.writableLength);
        return ok;
      }) as typeof res.write;
    });

    const body = await new Promise<number>((resolve, reject) => {
      const client = httpRequest({ host: "127.0.0.1", path: "/", port }, (response) => {
        let received = 0;
        response.pause();
        // A slow reader: the writer must stop at the high-water mark.
        setTimeout(() => {
          response.on("data", (data: Buffer) => (received += data.byteLength));
          response.on("end", () => resolve(received));
          response.resume();
        }, 100);
      });
      client.on("error", reject);
      client.end();
    });

    expect(body).toBe(total * chunk.byteLength);
    // Ignoring backpressure would queue all 8 MiB in the response.
    expect(maxBuffered).toBeLessThan(total * chunk.byteLength);
  });

  it("cancels the body when the client disconnects", async () => {
    let resolveCancelled!: () => void;
    const cancelled = new Promise<void>((resolve) => (resolveCancelled = resolve));
    const port = await listen(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new Uint8Array(64 * 1024));
              return new Promise((resolve) => setTimeout(resolve, 5));
            },
            cancel() {
              resolveCancelled();
            },
          }),
        ),
    );

    await new Promise<void>((resolve) => {
      const client = httpRequest({ host: "127.0.0.1", path: "/", port }, (response) => {
        response.once("data", () => {
          client.destroy();
          resolve();
        });
      });
      client.on("error", () => {});
      client.end();
    });

    await cancelled;
  });
});
