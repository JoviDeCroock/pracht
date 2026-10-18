/**
 * Server-side probe for one built route-scale app. Run by `bench/run.mjs` in a
 * child process with `--expose-gc`; prints one JSON object on stdout.
 *
 *   node --expose-gc bench/ssr-probe.mjs <dist/server/server.js> <requests>
 *
 * For each request kind it serves `requests` requests through the built
 * server's own Node handler over a real loopback socket, after a warm-up, and
 * reports requests per second plus the heap still retained after a full GC,
 * per request. Both numbers depend on the machine, so they are reported and
 * never gated; the retained-heap figure exists to make per-request state that
 * outlives its response (timers, caches keyed by request) visible as a trend.
 */
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const [serverEntry, requestsArg] = process.argv.slice(2);
const requests = Number.parseInt(requestsArg ?? "1000", 10);
const CONCURRENCY = 8;
const WARMUP = 100;

if (typeof globalThis.gc !== "function") {
  throw new Error("run with --expose-gc");
}

const { handler, resolvedApp } = await import(pathToFileURL(serverEntry).href);

const server = createServer(handler);
await new Promise((settle) => server.listen(0, "127.0.0.1", settle));
const origin = `http://127.0.0.1:${server.address().port}`;

// A route in the middle of the manifest, so matching does real work.
const middle = resolvedApp.routes[Math.floor(resolvedApp.routes.length / 2)].path.replace(
  /:[^/]+/g,
  "1",
);

// Each kind names the response it must get. A request that takes another path
// (an HTML document where route state was asked for, a 404 for a real route)
// counts as a failure, so a routing regression cannot pass as a speed-up.
const KINDS = [
  {
    kind: "ssr document",
    path: middle,
    headers: {},
    status: 200,
    contentType: "text/html",
    body: "<!DOCTYPE html>",
  },
  {
    kind: "route-state json",
    path: middle,
    headers: { "x-pracht-route-state-request": "1" },
    status: 200,
    contentType: "application/json",
    body: "{",
  },
  {
    kind: "not found",
    path: "/no/such/route",
    headers: {},
    status: 404,
    contentType: "",
    body: "",
  },
];

function invalid(expected, response, body) {
  if (response.status !== expected.status) return `status ${response.status}`;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.startsWith(expected.contentType)) return `content-type ${contentType}`;
  if (!body.includes(expected.body)) return `body without ${expected.body}`;
  return null;
}

async function serve(expected, count) {
  let next = 0;
  let failures = 0;
  let firstFailure = null;
  async function worker() {
    while (next < count) {
      next += 1;
      const response = await fetch(origin + expected.path, { headers: expected.headers });
      const problem = invalid(expected, response, await response.text());
      if (problem) {
        failures += 1;
        firstFailure ??= problem;
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { failures, firstFailure };
}

function settledHeap() {
  globalThis.gc();
  globalThis.gc();
  return process.memoryUsage().heapUsed;
}

const results = [];
for (const expected of KINDS) {
  const { kind, path } = expected;
  const warmup = await serve(expected, WARMUP);
  if (warmup.failures > 0) {
    throw new Error(`${kind} ${path}: wrong response (${warmup.firstFailure})`);
  }
  const heapBefore = settledHeap();
  const started = performance.now();
  const { failures } = await serve(expected, requests);
  const seconds = (performance.now() - started) / 1000;
  const heapAfter = settledHeap();
  results.push({
    kind,
    path,
    requests,
    failures,
    requestsPerSecond: Math.round(requests / seconds),
    retainedBytesPerRequest: Math.max(0, Math.round((heapAfter - heapBefore) / requests)),
  });
}

await new Promise((settle) => {
  server.close(settle);
  server.closeAllConnections();
});
console.log(JSON.stringify({ routes: resolvedApp.routes.length, results }));
// Timers a request left behind would otherwise keep this process alive.
process.exit(0);
