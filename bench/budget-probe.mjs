/**
 * Request-budget retention probe. Serves requests through the built
 * `@pracht/core` handler in-process and reports the heap still retained after
 * a full GC, per request, for the request kinds whose budget outlived its
 * response in the past: API routes that stream an app-built body, capability
 * POSTs, and capability POSTs rejected before `run()`.
 *
 *   pnpm build && node --expose-gc bench/budget-probe.mjs [requests]
 *
 * Every request carries its own client `AbortSignal`, as a Node adapter
 * request does, and its handler adds an abort listener the way a `fetch()`
 * would. The default budget (30 s) is far longer than the run, so a budget
 * timer left pending by a finished request shows up as retained heap.
 * Requests per second depend on the machine; the retained figure should stay
 * well under 200 B per request.
 */
import { performance } from "node:perf_hooks";

import { defineCapability } from "../packages/capabilities/dist/index.mjs";
import {
  defineApp,
  handlePrachtRequest,
  resolveApiRoutes,
  route,
} from "../packages/framework/dist/index.mjs";

const requests = Number.parseInt(process.argv[2] ?? "100000", 10);
const CONCURRENCY = 8;
const WARMUP = 1_000;

if (typeof globalThis.gc !== "function") {
  throw new Error("run with --expose-gc");
}

const encoder = new TextEncoder();

const echo = defineCapability({
  title: "Echo",
  description: "Returns its input.",
  effect: "read",
  input: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
  output: { type: "object", properties: { value: { type: "string" } } },
  expose: { http: true },
  async run({ input, signal }) {
    signal.addEventListener("abort", () => {});
    return { value: input.value };
  },
});

const app = defineApp({
  capabilities: { "bench.echo": "./capabilities/echo.ts" },
  routes: [route("/", "./routes/home.tsx")],
});
const apiRoutes = resolveApiRoutes(["/src/api/stream.ts"]);
const registry = {
  routeModules: { "./routes/home.tsx": async () => ({ Component: () => null }) },
  apiModules: {
    "/src/api/stream.ts": async () => ({
      GET: ({ signal }) => {
        signal.addEventListener("abort", () => {});
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode("first "));
            controller.enqueue(encoder.encode("second"));
            controller.close();
          },
        });
        return new Response(body, { headers: { "content-type": "text/plain" } });
      },
    }),
  },
  capabilityModules: { "./capabilities/echo.ts": async () => ({ default: echo }) },
};

const KINDS = [
  {
    kind: "api stream",
    status: 200,
    request: (signal) => new Request("http://localhost/api/stream", { signal }),
  },
  {
    kind: "capability POST",
    status: 200,
    request: (signal) =>
      new Request("http://localhost/api/capabilities/bench/echo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"value":"hi"}',
        signal,
      }),
  },
  {
    kind: "capability POST rejected",
    status: 400,
    request: (signal) =>
      new Request("http://localhost/api/capabilities/bench/echo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
        signal,
      }),
  },
];

async function serve(kind, count) {
  let next = 0;
  let failures = 0;
  async function worker() {
    while (next < count) {
      next += 1;
      const client = new AbortController();
      const response = await handlePrachtRequest({
        app,
        apiRoutes,
        registry,
        request: kind.request(client.signal),
      });
      await response.text();
      if (response.status !== kind.status) failures += 1;
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return failures;
}

async function settledHeap() {
  for (let round = 0; round < 3; round += 1) {
    globalThis.gc();
    await new Promise((resolve) => setImmediate(resolve));
  }
  return process.memoryUsage().heapUsed;
}

const results = [];
for (const kind of KINDS) {
  if ((await serve(kind, WARMUP)) > 0) throw new Error(`${kind.kind}: wrong status in warm-up`);
  const heapBefore = await settledHeap();
  const started = performance.now();
  const failures = await serve(kind, requests);
  const seconds = (performance.now() - started) / 1000;
  const heapAfter = await settledHeap();
  results.push({
    kind: kind.kind,
    requests,
    failures,
    seconds: Number(seconds.toFixed(1)),
    requestsPerSecond: Math.round(requests / seconds),
    retainedBytesPerRequest: Math.max(0, Math.round((heapAfter - heapBefore) / requests)),
  });
}

for (const row of results) {
  console.log(
    `${row.kind.padEnd(26)} ${String(row.requestsPerSecond).padStart(7)} req/s  ` +
      `${String(row.retainedBytesPerRequest).padStart(6)} B retained per request  ` +
      `(${row.requests} in ${row.seconds}s${row.failures ? `, ${row.failures} failed` : ""})`,
  );
}
// Budget timers a request left behind would otherwise keep this process alive.
process.exit(0);
