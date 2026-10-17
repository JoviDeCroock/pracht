import { describe, expect, it } from "vitest";

import { defineCapability } from "../../capabilities/src/index.ts";
import { createCapabilityHost } from "../../capabilities/src/server/index.ts";
import { defineApp, handlePrachtRequest, route } from "../src/index.ts";
import type { ModuleRegistry } from "../src/index.ts";

// A capability's `signal` must stop work the caller abandoned, and honour the
// app's request budget instead of a fixed 30 seconds.

interface Probe {
  aborted: boolean;
  reason?: unknown;
  middlewareSignal?: AbortSignal;
  runSignal?: AbortSignal;
}

function slowCapability(probe: Probe, expose: Record<string, unknown> = { http: true }) {
  return defineCapability({
    title: "Slow",
    description: "Waits until aborted or 2 seconds pass.",
    effect: "read",
    input: { type: "object", properties: {}, additionalProperties: false },
    output: { type: "object", properties: {} },
    expose,
    async run({ signal }) {
      probe.runSignal = signal;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        signal.addEventListener("abort", () => {
          probe.aborted = true;
          probe.reason = signal.reason;
          clearTimeout(timer);
          resolve();
        });
      });
      return {};
    },
  });
}

function abortableRequest(url: string, body: unknown, abortAfterMs: number): Request {
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("client went away")), abortAfterMs);
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: controller.signal,
  });
}

describe("capability abort signal", () => {
  it("aborts run() when the HTTP caller disconnects", async () => {
    const probe: Probe = { aborted: false };
    const host = createCapabilityHost({ capabilities: { "x.slow": slowCapability(probe) } });

    const started = performance.now();
    await host.fetch(abortableRequest("https://app.example/api/capabilities/x/slow", {}, 50));

    expect(probe.aborted).toBe(true);
    expect(performance.now() - started).toBeLessThan(1_500);
  });

  it("aborts a remote MCP tools/call when the MCP client disconnects", async () => {
    const probe: Probe = { aborted: false };
    const host = createCapabilityHost({
      capabilities: { "x.slow": slowCapability(probe, { http: true, mcp: true }) },
      agents: { mcp: {} },
    });

    const started = performance.now();
    await host.fetch(
      abortableRequest(
        "https://app.example/mcp",
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "x_slow", arguments: {} } },
        50,
      ),
    );

    expect(probe.aborted).toBe(true);
    expect(performance.now() - started).toBeLessThan(1_500);
  });

  it("uses defineApp({ loaderTimeoutMs }) as the budget, shared with api.middleware", async () => {
    const probe: Probe = { aborted: false };
    const app = defineApp({
      loaderTimeoutMs: 50,
      api: { middleware: ["observe"] },
      middleware: { observe: "./middleware/observe.ts" },
      capabilities: { "x.slow": "./capabilities/slow.ts" },
      routes: [route("/", "./routes/home.tsx")],
    });
    const registry: ModuleRegistry = {
      routeModules: { "./routes/home.tsx": async () => ({ Component: () => null }) },
      middlewareModules: {
        "./middleware/observe.ts": async () => ({
          middleware: async (args: { signal: AbortSignal }, next: () => Promise<Response>) => {
            probe.middlewareSignal = args.signal;
            return next();
          },
        }),
      },
      capabilityModules: {
        "./capabilities/slow.ts": (async () => ({
          default: slowCapability(probe),
        })) as NonNullable<ModuleRegistry["capabilityModules"]>[string],
      },
    };

    const started = performance.now();
    await handlePrachtRequest({
      app,
      registry,
      request: new Request("http://localhost/api/capabilities/x/slow", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    });

    expect(probe.aborted).toBe(true);
    expect((probe.reason as Error).name).toBe("TimeoutError");
    expect(performance.now() - started).toBeLessThan(1_500);
    expect(probe.runSignal).toBe(probe.middlewareSignal);
  });
});
