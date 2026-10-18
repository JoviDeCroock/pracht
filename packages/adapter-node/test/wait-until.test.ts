import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defineApp, resolveApiRoutes } from "@pracht/core";

import { createNodeRequestHandler, createNodeServerEntryModule } from "../src/index.ts";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const servers = new Set<ReturnType<typeof createServer>>();
const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers) {
    server.close();
    await once(server, "close");
  }
  servers.clear();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { force: true, recursive: true });
  }
});

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => unknown) {
  const server = createServer((req, res) => void handler(req, res));
  servers.add(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolveRequest, reject) => {
    const req = httpRequest({ hostname: "127.0.0.1", port, path }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolveRequest({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function apiHandler(GET: (args: { waitUntil(promise: Promise<unknown>): void }) => Response) {
  return createNodeRequestHandler({
    app: defineApp({ routes: [] }),
    apiRoutes: resolveApiRoutes(["/src/api/work.ts"]),
    canonicalOrigin: "http://localhost",
    registry: { apiModules: { "/src/api/work.ts": async () => ({ GET }) } },
  });
}

describe("waitUntil on the Node adapter", () => {
  it("answers before registered work settles and drains it on demand", async () => {
    const work = deferred();
    const handler = apiHandler(({ waitUntil }) => {
      waitUntil(work.promise);
      return new Response("sent");
    });
    const port = await listen(handler);

    const response = await get(port, "/api/work");
    expect(response).toEqual({ status: 200, body: "sent" });
    expect(handler.pending).toBe(1);

    const drained = handler.drain(1_000);
    work.resolve();
    await expect(drained).resolves.toBe(true);
    expect(handler.pending).toBe(0);
  });

  it("logs a rejected task instead of crashing the process", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = apiHandler(({ waitUntil }) => {
      waitUntil(Promise.reject(new Error("webhook delivery failed")));
      return new Response("sent");
    });
    const port = await listen(handler);

    expect((await get(port, "/api/work")).status).toBe(200);
    await expect(handler.drain(1_000)).resolves.toBe(true);
    expect(String(errors.mock.calls[0]?.[0])).toContain(
      "[pracht] waitUntil error (/src/api/work.ts) at /api/work: webhook delivery failed",
    );
  });

  it("bounds the drain with a timeout", async () => {
    const handler = apiHandler(({ waitUntil }) => {
      waitUntil(new Promise(() => {}));
      return new Response("sent");
    });
    const port = await listen(handler);

    await get(port, "/api/work");
    await expect(handler.drain(20)).resolves.toBe(false);
  });
});

describe("closeEventStreams", () => {
  it("closes open event streams and leaves other streaming responses alone", async () => {
    const cancelled: string[] = [];
    const streamFor = (name: string) =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`${name}\n`));
        },
        cancel() {
          cancelled.push(name);
        },
      });
    const handler = createNodeRequestHandler({
      app: defineApp({ routes: [] }),
      apiRoutes: resolveApiRoutes(["/src/api/events.ts", "/src/api/export.ts"]),
      canonicalOrigin: "http://localhost",
      compression: false,
      registry: {
        apiModules: {
          "/src/api/events.ts": async () => ({
            GET: () =>
              new Response(streamFor("events"), {
                headers: { "content-type": "text/event-stream" },
              }),
          }),
          "/src/api/export.ts": async () => ({
            GET: () =>
              new Response(streamFor("export"), { headers: { "content-type": "text/csv" } }),
          }),
        },
      },
    });
    const port = await listen(handler);
    const open = (path: string) =>
      new Promise<IncomingMessage>((resolveStream, reject) => {
        const req = httpRequest({ hostname: "127.0.0.1", port, path }, resolveStream);
        req.on("error", reject);
        req.end();
      });

    const events = await open("/api/events");
    const csv = await open("/api/export");
    await Promise.all([once(events, "data"), once(csv, "data")]);
    events.on("error", () => {});
    const eventsClosed = new Promise((resolveClose) => events.on("close", resolveClose));

    try {
      handler.closeEventStreams();

      await eventsClosed;
      await vi.waitFor(() => expect(cancelled).toEqual(["events"]));
      expect(csv.destroyed).toBe(false);
    } finally {
      csv.destroy();
    }
  });

  it("closes streams before their first event and ones opened afterwards, then drains their work", async () => {
    const work: string[] = [];
    const started = { quiet: deferred(), late: deferred() };
    const handler = createNodeRequestHandler({
      app: defineApp({ routes: [] }),
      apiRoutes: resolveApiRoutes(["/src/api/quiet.ts", "/src/api/late.ts"]),
      canonicalOrigin: "http://localhost",
      compression: false,
      registry: {
        apiModules: Object.fromEntries(
          (["quiet", "late"] as const).map((name) => [
            `/src/api/${name}.ts`,
            async () => ({
              GET: ({
                request,
                waitUntil,
              }: {
                request: Request;
                waitUntil(promise: Promise<unknown>): void;
              }) => {
                request.signal.addEventListener("abort", () =>
                  waitUntil(new Promise((r) => setTimeout(r, 50)).then(() => work.push(name))),
                );
                // Never enqueues: the headers are staged but not yet sent.
                // `pull` with no buffer runs once the adapter reads the body.
                const body = new ReadableStream(
                  { pull: () => started[name].resolve() },
                  { highWaterMark: 0 },
                );
                return new Response(body, { headers: { "content-type": "text/event-stream" } });
              },
            }),
          ]),
        ),
      },
    });
    const port = await listen(handler);
    const hangUp = (path: string) =>
      new Promise<void>((resolveHangUp) => {
        const req = httpRequest({ hostname: "127.0.0.1", port, path });
        req.on("error", () => resolveHangUp());
        req.on("close", () => resolveHangUp());
        req.end();
      });

    const quiet = hangUp("/api/quiet");
    await started.quiet.promise;
    await handler.closeEventStreams();
    await quiet;
    expect(await handler.drain(2_000)).toBe(true);
    expect(work).toEqual(["quiet"]);

    const late = hangUp("/api/late");
    await started.late.promise;
    await late;
    await handler.closeEventStreams();
    expect(await handler.drain(2_000)).toBe(true);
    expect(work).toEqual(["quiet", "late"]);
  });

  it("waits for a request still answering when called, then drains its stream's work", async () => {
    const work: string[] = [];
    const entered = deferred();
    const answer = deferred();
    const handler = createNodeRequestHandler({
      app: defineApp({ routes: [] }),
      apiRoutes: resolveApiRoutes(["/src/api/slow.ts"]),
      canonicalOrigin: "http://localhost",
      compression: false,
      registry: {
        apiModules: {
          "/src/api/slow.ts": async () => ({
            GET: async ({
              request,
              waitUntil,
            }: {
              request: Request;
              waitUntil(promise: Promise<unknown>): void;
            }) => {
              request.signal.addEventListener("abort", () =>
                waitUntil(new Promise((r) => setTimeout(r, 20)).then(() => work.push("slow"))),
              );
              entered.resolve();
              await answer.promise;
              return new Response(new ReadableStream(), {
                headers: { "content-type": "text/event-stream" },
              });
            },
          }),
        },
      },
    });
    const port = await listen(handler);
    const req = httpRequest({ hostname: "127.0.0.1", port, path: "/api/slow" });
    const hungUp = new Promise<void>((resolveHangUp) => {
      req.on("error", () => resolveHangUp());
      req.on("close", () => resolveHangUp());
    });
    req.end();

    await entered.promise;
    const closed = handler.closeEventStreams();
    setTimeout(() => answer.resolve(), 20);
    await closed;
    expect(await handler.drain(2_000)).toBe(true);
    expect(work).toEqual(["slow"]);
    await hungUp;
  });

  it("stops waiting for unanswered requests at its timeout", async () => {
    const entered = deferred();
    const answer = deferred();
    const handler = apiHandler(() => {
      entered.resolve();
      return answer.promise.then(() => new Response("late")) as unknown as Response;
    });
    const port = await listen(handler);
    const response = get(port, "/api/work");

    await entered.promise;
    const started = Date.now();
    await handler.closeEventStreams(50);
    expect(Date.now() - started).toBeLessThan(1_000);
    answer.resolve();
    expect((await response).body).toBe("late");
  });
});

describe("server timeouts of the generated Node entry", () => {
  it("sets keep-alive and header timeouts only when configured", () => {
    expect(createNodeServerEntryModule()).not.toContain("keepAliveTimeout");
    const source = createNodeServerEntryModule({
      keepAliveTimeoutMs: 65_000,
      headersTimeoutMs: 66_000,
    });
    expect(source).toContain("server.keepAliveTimeout = 65000;");
    expect(source).toContain("server.headersTimeout = 66000;");
    expect(() => createNodeServerEntryModule({ keepAliveTimeoutMs: -1 })).toThrow(
      "nodeAdapter({ keepAliveTimeoutMs }) expects a non-negative number of milliseconds.",
    );
  });
});

describe("graceful shutdown of the generated Node entry", () => {
  /**
   * Run the real generated entry as its own process: an API route registers
   * work that finishes after the response, then the process gets a signal.
   */
  async function startEntry(options: { workMs: number; shutdownTimeoutMs?: number }) {
    mkdirSync(join(packageDir, ".tmp"), { recursive: true });
    const dir = mkdtempSync(join(packageDir, ".tmp", "shutdown-"));
    tempDirs.push(dir);
    const marker = join(dir, "finished.txt");
    const streamMarker = join(dir, "stream-closed.txt");
    const entry = join(dir, "server.mjs");
    const port = await freePort();

    const prelude = [
      'import { writeFileSync } from "node:fs";',
      'import { defineApp, resolveApiRoutes, resolveApp } from "@pracht/core/server";',
      "const resolvedApp = resolveApp(defineApp({ routes: [] }));",
      'const apiRoutes = resolveApiRoutes(["/src/api/work.ts", "/src/api/events.ts"]);',
      "const registry = { apiModules: { '/src/api/work.ts': async () => ({",
      "  GET: ({ waitUntil }) => {",
      `    waitUntil(new Promise((r) => setTimeout(r, ${options.workMs})).then(() =>`,
      `      writeFileSync(${JSON.stringify(marker)}, "done")));`,
      '    return new Response("sent");',
      "  },",
      "}), '/src/api/events.ts': async () => ({",
      "  GET: ({ request, waitUntil }) => {",
      "    request.signal.addEventListener('abort', () => waitUntil(",
      "      new Promise((r) => setTimeout(r, 50)).then(() =>",
      `        writeFileSync(${JSON.stringify(streamMarker)}, "closed"))));`,
      "    return new Response(new ReadableStream({",
      "      start(controller) { controller.enqueue(new TextEncoder().encode('data: hi\\n\\n')); },",
      "    }), { headers: { 'content-type': 'text/event-stream' } });",
      "  },",
      "}) } };",
      "const clientEntryUrl = null;",
      "const islandsEntryUrl = null;",
      "const islandsBootstrapRequired = false;",
      "const cssManifest = {};",
      "const cssContentManifest = {};",
      "const jsManifest = {};",
    ].join("\n");
    const source = createNodeServerEntryModule({
      canonicalOrigin: "http://localhost",
      shutdownTimeoutMs: options.shutdownTimeoutMs,
    }).replace('"@pracht/adapter-node"', JSON.stringify(join(packageDir, "src/index.ts")));
    writeFileSync(entry, `${prelude}\n${source}`);

    const child = spawn(process.execPath, [entry], {
      cwd: dir,
      env: { ...process.env, NODE_ENV: "production", PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const exited = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
    await waitFor(
      () => output.includes("listening"),
      () => output,
    );
    return { child, exited, marker, port, streamMarker };
  }

  it("waits for waitUntil() work before exiting on SIGTERM", async () => {
    const { child, exited, marker, port } = await startEntry({ workMs: 300 });

    expect(await get(port, "/api/work")).toEqual({ status: 200, body: "sent" });
    expect(existsSync(marker)).toBe(false);
    child.kill("SIGTERM");

    const [code, signal] = await exited;
    expect(existsSync(marker)).toBe(true);
    // The signal is re-raised once drained, so the exit looks like any SIGTERM.
    expect({ code, signal }).toEqual({ code: null, signal: "SIGTERM" });
  }, 15_000);

  it("closes open event streams instead of waiting out the shutdown timeout", async () => {
    const { child, exited, port, streamMarker } = await startEntry({ workMs: 0 });

    const stream = await new Promise<IncomingMessage>((resolveStream, reject) => {
      const req = httpRequest({ hostname: "127.0.0.1", port, path: "/api/events" }, resolveStream);
      req.on("error", reject);
      req.end();
    });
    expect(stream.headers["content-type"]).toBe("text/event-stream");
    await once(stream, "data");
    stream.on("error", () => {});
    stream.resume();

    const startedAt = Date.now();
    child.kill("SIGTERM");
    const [, signal] = await exited;
    expect(signal).toBe("SIGTERM");
    // The default 10s budget would otherwise be spent waiting on the stream.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    // Work the stream's abort listener registered was drained, not cut off.
    expect(existsSync(streamMarker)).toBe(true);
  }, 20_000);

  it("stops waiting at shutdownTimeoutMs", async () => {
    const { child, exited, marker, port } = await startEntry({
      workMs: 10_000,
      shutdownTimeoutMs: 100,
    });

    await get(port, "/api/work");
    const startedAt = Date.now();
    child.kill("SIGINT");

    const [, signal] = await exited;
    expect(signal).toBe("SIGINT");
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(existsSync(marker)).toBe(false);
  }, 15_000);
});

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  server.close();
  await once(server, "close");
  return port;
}

async function waitFor(predicate: () => boolean, describe: () => string): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 10_000) {
      throw new Error(`Timed out waiting for the entry to listen:\n${describe()}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}
