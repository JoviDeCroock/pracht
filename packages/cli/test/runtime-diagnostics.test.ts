import { createServer, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { devDiagnosticsUrl, readRuntimeDiagnostics } from "../src/runtime-diagnostics.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function serve(
  handler: (response: ServerResponse, path: string) => void,
  host = "127.0.0.1",
) {
  const server = createServer((request, response) => handler(response, request.url ?? ""));
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
  return `http://${host === "::1" ? "[::1]" : host}:${address.port}`;
}

function diagnostics() {
  return {
    schema: "pracht-dev-diagnostics/v1",
    root: process.cwd(),
    errors: {
      limit: 50,
      recorded: 2,
      events: ["new", "old"].map((message) => ({
        at: 123,
        path: "/boom",
        phase: "loader",
        routeId: "boom",
        file: "./routes/boom.tsx",
        message,
        stack: `${message} stack`,
      })),
    },
    agentTraffic: { limit: 200, recorded: 0, events: [] },
  };
}

describe("local runtime diagnostics", () => {
  it("reads the fixed endpoint under the Vite base and limits returned history", async () => {
    const origin = await serve((res, path) => {
      expect(path).toBe("/app/_pracht.json?diagnostics=1");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(diagnostics()));
    });
    const result = await readRuntimeDiagnostics({
      url: `${origin}/app/`,
      root: process.cwd(),
      limit: 1,
    });
    expect(result.errors.recorded).toBe(2);
    expect(result.errors.events.map((error) => error.message)).toEqual(["new"]);
  });

  it.each([
    "https://example.com/",
    "http://127.0.0.2/",
    "http://localhost.example/",
    "http://user:password@localhost/",
    "http://localhost/?x=1",
    "http://localhost/#x",
    "file:///tmp/error.json",
  ])("refuses non-loopback or ambiguous URL %s before connecting", (url) => {
    expect(() => devDiagnosticsUrl(url)).toThrow("loopback dev-server URL");
  });

  it("preserves the base and explicit IPv6 URLs", () => {
    expect(devDiagnosticsUrl("http://localhost:3000").href).toBe(
      "http://localhost:3000/_pracht.json?diagnostics=1",
    );
    expect(devDiagnosticsUrl("http://[::1]:3000").hostname).toBe("[::1]");
  });

  it("reads the printed localhost URL when Vite listens only on IPv6", async () => {
    const origin = await serve((res, path) => {
      expect(path).toBe("/app/_pracht.json?diagnostics=1");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(diagnostics()));
    }, "::1");
    const result = await readRuntimeDiagnostics({
      url: `${origin.replace("[::1]", "localhost")}/app/`,
      root: process.cwd(),
    });
    expect(result.errors.recorded).toBe(2);
  });

  it("does not follow redirects", async () => {
    const origin = await serve((res) => {
      res.writeHead(302, { location: "https://example.com/" });
      res.end();
    });
    await expect(readRuntimeDiagnostics({ url: origin, root: process.cwd() })).rejects.toThrow();
  });

  it("identifies a different project's server", async () => {
    const origin = await serve((res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ...diagnostics(), root: "/" }));
    });
    await expect(readRuntimeDiagnostics({ url: origin, root: process.cwd() })).rejects.toThrow(
      "another project",
    );
  });

  it("rejects an unrelated JSON endpoint", async () => {
    const origin = await serve((res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ errors: [] }));
    });
    await expect(readRuntimeDiagnostics({ url: origin, root: process.cwd() })).rejects.toThrow(
      "supported Pracht dev diagnostics format",
    );
  });

  it("bounds the bytes read from a local server", async () => {
    const origin = await serve((res) => {
      res.setHeader("content-type", "application/json");
      res.end(" ".repeat(1024 * 1024 + 1));
    });
    await expect(readRuntimeDiagnostics({ url: origin, root: process.cwd() })).rejects.toThrow(
      "1 MiB",
    );
  });

  it("explains when preview or an adapter-owned server has no diagnostics endpoint", async () => {
    const origin = await serve((res) => {
      res.writeHead(404);
      res.end();
    });
    await expect(readRuntimeDiagnostics({ url: origin, root: process.cwd() })).rejects.toThrow(
      "Adapter-owned dev servers",
    );
  });
});
