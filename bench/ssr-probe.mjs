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

const KINDS = [
  { kind: "ssr document", path: middle, headers: {} },
  { kind: "route-state json", path: middle, headers: { "x-pracht-route-state-request": "1" } },
  { kind: "not found", path: "/no/such/route", headers: {} },
];

async function serve(path, headers, count) {
  let next = 0;
  let failures = 0;
  async function worker() {
    while (next < count) {
      next += 1;
      const response = await fetch(origin + path, { headers });
      await response.arrayBuffer();
      if (response.status >= 500) failures += 1;
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return failures;
}

function settledHeap() {
  globalThis.gc();
  globalThis.gc();
  return process.memoryUsage().heapUsed;
}

const results = [];
for (const { kind, path, headers } of KINDS) {
  await serve(path, headers, WARMUP);
  const heapBefore = settledHeap();
  const started = performance.now();
  const failures = await serve(path, headers, requests);
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
