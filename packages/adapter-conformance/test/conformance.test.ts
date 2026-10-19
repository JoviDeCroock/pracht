// Adapter conformance: one request matrix, run at the handler level against
// every adapter and the dev middleware. Behaviour that differs between
// adapters today is recorded as an `it.fails` (or `it.todo`) cell tagged with
// the rewrite step expected to converge it; the count of those cells is the
// baseline the last test ratchets.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CLIENT_VITE_MANIFEST,
  CORS_ORIGIN,
  createFixture,
  createMockCache,
  createStaticOutput,
  headerRecord,
  ISG_PATHS,
  ISG_RENDER_HEADERS,
  MAX_BODY_SIZE,
  REVALIDATE_TOKEN,
  SAME_ORIGIN,
  startCloudflare,
  startDev,
  startNetlify,
  startNode,
  startStaticPreview,
  startVercelEdge,
  startVercelNode,
  VIDEO_BYTES,
  type Fixture,
  type Session,
  type StaticOutput,
  type TargetId,
} from "./harness.ts";
import { divergences, na, row, run, type Cell } from "./matrix.ts";

let output: StaticOutput;
let fixture: Fixture;
const open: Session[] = [];

beforeEach(() => {
  output = createStaticOutput();
  fixture = createFixture();
  vi.stubEnv("PRACHT_REVALIDATE_TOKEN", REVALIDATE_TOKEN);
  // Regeneration paths log refused or stripped renders on purpose.
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  for (const session of open.splice(0)) await session.close();
  output.cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function start(target: TargetId, f: Fixture = fixture): Promise<Session> {
  const session = await {
    node: () => startNode(f, output),
    cloudflare: () => startCloudflare(f, output),
    netlify: () => startNetlify(f, output),
    "vercel-edge": () => startVercelEdge(f),
    "vercel-node": () => startVercelNode(f),
    "static-preview": () => startStaticPreview(output),
    dev: () => startDev(f),
  }[target]();
  open.push(session);
  return session;
}

const PLATFORM_STATIC = na("the platform's CDN serves static files, not the handler");
const VITE_STATIC = na("Vite's own middleware serves static files in dev");
const NO_APP = na("serves files only; there is no app to reach");
const ISG_ONLY = na("runs only ISG renders");

const STATIC_CELLS = {
  node: run,
  cloudflare: PLATFORM_STATIC,
  netlify: run,
  "vercel-edge": PLATFORM_STATIC,
  "vercel-node": ISG_ONLY,
  "static-preview": run,
  dev: VITE_STATIC,
} satisfies Record<TargetId, Cell>;

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

row("serves a public file whose name needs percent-encoding", STATIC_CELLS, async (target) => {
  const session = await start(target);
  const response = await session.fetch("/legal%20terms.txt");
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("legal");
});

row(
  "serves a prerendered page at its percent-encoded route path (#471)",
  STATIC_CELLS,
  async (target) => {
    const session = await start(target);
    const response = await session.fetch("/posts/caf%C3%A9");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("café");
  },
);

// A case-folding filesystem (macOS, Windows) finds the file whatever the
// escape case; the row proves the rule only where names are case-sensitive
// (CI on Linux).
row(
  "serves the same page for a lowercase percent-escape (#471 escape case)",
  STATIC_CELLS,
  async (target) => {
    const session = await start(target);
    const response = await session.fetch("/posts/caf%c3%a9");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("café");
  },
);

row("never serves a file outside the static directory", STATIC_CELLS, async (target) => {
  const session = await start(target);
  for (const path of ["/..%2fsecret.txt", "/%2e%2e/secret.txt", "/assets/..%2f..%2fsecret.txt"]) {
    const response = await session.fetch(path);
    const body = await response.text();
    expect(body, path).not.toContain(readFileSync(output.secretPath, "utf-8"));
  }
});

// Vercel publishes dist/client as its static output, the static export ships
// it and Cloudflare uploads it: the build moving the manifest out is what
// keeps it private there, and the mocked assets binding serves the result.
row(
  "never serves the client build's Vite manifest",
  { ...STATIC_CELLS, cloudflare: run },
  async (target) => {
    const session = await start(target);
    for (const path of [`/${CLIENT_VITE_MANIFEST}`, "/.vite/", "/.vite"]) {
      const response = await session.fetch(path);
      expect(response.status, path).not.toBe(200);
      expect(await response.text(), path).not.toContain("src/x.tsx");
    }
  },
);

/** Content-Type per extension; the media type (before `;`) must match. */
const MEDIA_TYPES: Record<string, string> = {
  "/assets/app-abc123.js": "application/javascript",
  "/styles.css": "text/css",
  "/data.json": "application/json",
  "/logo.svg": "image/svg+xml",
  "/icon.png": "image/png",
  "/image.avif": "image/avif",
  "/font.woff2": "font/woff2",
  "/notes.txt": "text/plain",
  "/readme.md": "text/markdown",
  "/feed.xml": "application/xml",
  "/site.webmanifest": "application/manifest+json",
  "/module.wasm": "application/wasm",
  "/video.mp4": "video/mp4",
  "/audio.mp3": "audio/mpeg",
  "/doc.pdf": "application/pdf",
  "/rows.csv": "text/csv",
};

row("answers each static file with its media type", STATIC_CELLS, async (target) => {
  const session = await start(target);
  const seen: Record<string, string | null> = {};
  for (const path of Object.keys(MEDIA_TYPES)) {
    const response = await session.fetch(path);
    await response.arrayBuffer();
    seen[path] = response.headers.get("content-type")?.split(";")[0]?.trim() ?? null;
  }
  expect(seen).toEqual(MEDIA_TYPES);
});

row(
  "answers each static file with the same Content-Type as every other adapter",
  STATIC_CELLS,
  async (target) => {
    const reference = await start("node");
    const session = target === "node" ? reference : await start(target);
    const differing: Record<string, [string | null, string | null]> = {};
    for (const path of Object.keys(MEDIA_TYPES)) {
      const [expected, actual] = await Promise.all([reference.fetch(path), session.fetch(path)]);
      await Promise.all([expected.arrayBuffer(), actual.arrayBuffer()]);
      const pair: [string | null, string | null] = [
        expected.headers.get("content-type"),
        actual.headers.get("content-type"),
      ];
      if (pair[0] !== pair[1]) differing[path] = pair;
    }
    expect(differing).toEqual({});
  },
);

row(
  "answers a byte range with 206 and only those bytes",
  {
    ...STATIC_CELLS,
    // The assets binding answers the range; the row checks the adapter keeps it.
    cloudflare: run,
  },
  async (target) => {
    const session = await start(target);
    const full = await session.fetch("/video.mp4");
    await full.arrayBuffer();
    expect(full.headers.get("accept-ranges")).toBe("bytes");

    const partial = await session.fetch("/video.mp4", { headers: { range: "bytes=0-99" } });
    const body = Buffer.from(await partial.arrayBuffer());
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe("bytes 0-99/1000");
    expect(partial.headers.get("content-type")).toBe("video/mp4");
    expect(body.equals(VIDEO_BYTES.subarray(0, 100))).toBe(true);
  },
);

// ---------------------------------------------------------------------------
// Request bodies and disconnects
// ---------------------------------------------------------------------------

const PLATFORM_BODY_LIMIT = na("the platform enforces the request size limit");

row(
  "answers an oversize body with 413 and the default security headers",
  {
    node: run,
    cloudflare: PLATFORM_BODY_LIMIT,
    netlify: PLATFORM_BODY_LIMIT,
    "vercel-edge": PLATFORM_BODY_LIMIT,
    "vercel-node": ISG_ONLY,
    "static-preview": NO_APP,
    dev: run,
  },
  async (target) => {
    const session = await start(target);
    const response = await session.fetch("/api/echo", {
      method: "POST",
      headers: { "content-type": "text/plain", ...SAME_ORIGIN },
      body: "x".repeat(MAX_BODY_SIZE * 4),
    });
    await response.text();
    expect(response.status).toBe(413);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(response.headers.get("permissions-policy")).toBeTruthy();
  },
);

row(
  "lets an API route's own OPTIONS export answer a cross-origin preflight",
  {
    node: run,
    cloudflare: run,
    netlify: run,
    "vercel-edge": run,
    "vercel-node": ISG_ONLY,
    "static-preview": NO_APP,
    dev: run,
  },
  async (target) => {
    const session = await start(target);
    const crossOrigin = { origin: CORS_ORIGIN, "sec-fetch-site": "cross-site" };
    const preflight = await session.fetch("/api/cors", {
      method: "OPTIONS",
      headers: { ...crossOrigin, "access-control-request-method": "POST" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(CORS_ORIGIN);
    // The state-changing request itself, and OPTIONS to a route without its
    // own handler, still meet the same-origin gate.
    for (const [path, method] of [
      ["/api/cors", "POST"],
      ["/api/echo", "OPTIONS"],
    ]) {
      const response = await session.fetch(path, { method, headers: crossOrigin });
      await response.text();
      expect(response.status, `${method} ${path}`).toBe(403);
    }
  },
);

const DISCONNECT_CELLS = {
  node: run,
  cloudflare: run,
  netlify: run,
  "vercel-edge": run,
  "vercel-node": ISG_ONLY,
  "static-preview": NO_APP,
  dev: run,
} satisfies Record<TargetId, Cell>;

row("aborts a loader's signal when the client disconnects", DISCONNECT_CELLS, async (target) => {
  const session = await start(target);
  await session.disconnect("/slow", {}, fixture.probe.loaderStarted);
  expect(await fixture.probe.loaderSettled).toBe(true);
});

row(
  "aborts a capability's signal when the client disconnects",
  DISCONNECT_CELLS,
  async (target) => {
    const session = await start(target);
    await session.disconnect(
      "/api/capabilities/x/slow",
      { method: "POST", body: "{}" },
      fixture.probe.capabilityStarted,
    );
    expect(await fixture.probe.capabilitySettled).toBe(true);
  },
);

// ---------------------------------------------------------------------------
// ISG snapshots
// ---------------------------------------------------------------------------

/**
 * What the target's shared cache replays after one regeneration of `path`,
 * or `null` when the render was not stored.
 */
async function replayedRender(
  target: TargetId,
  path: string,
  session?: Session,
): Promise<Response | null> {
  session ??= await start(target);
  if (target === "node" || target === "cloudflare") {
    // The prerendered page is stale: serving it schedules the regeneration.
    await (await session.fetch(path, { headers: { accept: "text/html" } })).text();
    await session.settle();
    const replayed = await session.fetch(path, { headers: { accept: "text/html" } });
    const body = await replayed.text();
    if (!body.includes("render-of:")) return null;
    return new Response(body, { status: replayed.status, headers: replayed.headers });
  }
  // Vercel's prerender cache and Netlify's CDN store the function's answer.
  const response = await session.fetch(path, { headers: { accept: "text/html" } });
  const body = await response.text();
  const stored =
    response.status === 200 && (target !== "netlify" || netlifyCdnStores(response.headers));
  return stored ? new Response(body, { status: response.status, headers: response.headers }) : null;
}

/** Netlify's CDN reads the first of these it finds and shares what it allows. */
function netlifyCdnStores(headers: Headers): boolean {
  const policy =
    headers.get("netlify-cdn-cache-control") ??
    headers.get("cdn-cache-control") ??
    headers.get("cache-control") ??
    "";
  return (
    !/\b(private|no-store)\b/i.test(policy) && /\b(public|s-maxage|max-age=[1-9])/i.test(policy)
  );
}

const ISG_CELLS = {
  node: run,
  cloudflare: run,
  netlify: run,
  "vercel-edge": na("ISG renders run in the Vercel Node function"),
  "vercel-node": run,
  "static-preview": NO_APP,
  dev: na("dev renders ISG routes per request"),
} satisfies Record<TargetId, Cell>;

/** Headers that describe one transfer, or the target's own cache bookkeeping. */
const TRANSFER_HEADERS = new Set([
  "age",
  "connection",
  "content-encoding",
  "content-length",
  "date",
  "etag",
  "keep-alive",
  "last-modified",
  "transfer-encoding",
  "x-pracht-isg",
]);

row(
  "replays the same document headers for one ISG render",
  {
    ...ISG_CELLS,
    netlify: na("Netlify's CDN headers are platform policy"),
  },
  async (target) => {
    const replayed = await replayedRender(target, ISG_PATHS.page);
    expect(replayed).not.toBeNull();
    const reference = target === "node" ? replayed! : await replayedRender("node", ISG_PATHS.page);
    expect(headerRecord(replayed!.headers, TRANSFER_HEADERS)).toEqual(
      headerRecord(reference!.headers, TRANSFER_HEADERS),
    );
  },
);

row("strips secret-shaped headers from a replayed ISG render", ISG_CELLS, async (target) => {
  const replayed = await replayedRender(target, ISG_PATHS.page);
  expect(replayed).not.toBeNull();
  expect(replayed!.headers.get("x-api-token")).toBeNull();
  expect(replayed!.headers.get("x-custom")).toBe(ISG_RENDER_HEADERS["x-custom"]);
});

row("keeps the render's Cache-Control on a replayed ISG render", ISG_CELLS, async (target) => {
  const replayed = await replayedRender(target, ISG_PATHS.page);
  expect(replayed).not.toBeNull();
  expect(replayed!.headers.get("cache-control")).toBe(ISG_RENDER_HEADERS["cache-control"]);
});

row(
  "answers an ISG page's index.html spelling with the same snapshot",
  {
    ...ISG_CELLS,
    cloudflare: na("the assets binding's html_handling redirects index.html to the page"),
    // The shared fixture writes `<page>/index.html` for every target; a real
    // Netlify build writes none, so the alias is the app's 404 there.
    netlify: na("Netlify builds emit no ISG HTML; the alias is a 404"),
    "vercel-node": na("Vercel routes the prerender function by the page path"),
  },
  async (target) => {
    const session = await start(target);
    const replayed = await replayedRender(target, ISG_PATHS.page, session);
    expect(replayed).not.toBeNull();
    const alias = await session.fetch(`${ISG_PATHS.page}/index.html`, {
      headers: { accept: "text/html" },
    });
    expect(await alias.text()).toBe(await replayed!.text());
    expect(headerRecord(alias.headers, TRANSFER_HEADERS)).toEqual(
      headerRecord(replayed!.headers, TRANSFER_HEADERS),
    );
  },
);

row(
  "answers a lowercase percent-escape of an ISG page from its snapshot (#471 escape case)",
  {
    ...ISG_CELLS,
    "vercel-node": na("Vercel routes the prerender function by the page path"),
  },
  async (target) => {
    const session = await start(target);
    const lowercase = ISG_PATHS.escaped.toLowerCase();
    if (target === "netlify") {
      // The CDN keys by URL; the function must answer the spelling as the page,
      // tagged so one purge of the page clears both entries.
      const [upper, lower] = await Promise.all([
        session.fetch(ISG_PATHS.escaped, { headers: { accept: "text/html" } }),
        session.fetch(lowercase, { headers: { accept: "text/html" } }),
      ]);
      await Promise.all([upper.text(), lower.text()]);
      expect(netlifyCdnStores(lower.headers)).toBe(true);
      expect(lower.headers.get("netlify-cache-tag")).toBe(upper.headers.get("netlify-cache-tag"));
      return;
    }
    const replayed = await replayedRender(target, ISG_PATHS.escaped, session);
    expect(replayed).not.toBeNull();
    const rendersBefore = fixture.renders.get(ISG_PATHS.escaped);
    const response = await session.fetch(lowercase, { headers: { accept: "text/html" } });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(await replayed!.text());
    expect(fixture.renders.get(ISG_PATHS.escaped)).toBe(rendersBefore);
  },
);

row(
  "refuses to store an ISG render that sets a cookie",
  // Vercel stores any 200 the function answers, so it answers a 503 instead.
  ISG_CELLS,
  async (target) => {
    expect(await replayedRender(target, ISG_PATHS.cookie)).toBeNull();
  },
);

row("refuses to store a private ISG render", ISG_CELLS, async (target) => {
  expect(await replayedRender(target, ISG_PATHS.private)).toBeNull();
});

// ---------------------------------------------------------------------------
// Deploy rollover
// ---------------------------------------------------------------------------

row(
  "never serves ISG HTML an older build rendered",
  {
    node: run,
    cloudflare: run,
    netlify: na("Netlify's durable cache is per deploy"),
    "vercel-edge": na("Vercel's prerender cache is per deployment"),
    "vercel-node": na("Vercel's prerender cache is per deployment"),
    "static-preview": NO_APP,
    dev: na("dev has no ISG store"),
  },
  async (target) => {
    // Build B's output is in place, but build A is still running (a rolling
    // deploy) and shares the store: A regenerates the page with its own code.
    const now = Date.now();
    output.cleanup();
    output = createStaticOutput({ build: "B", generatedAt: now - 3_600_000 });
    const oldBuild = createFixture({ build: "A", generatedAt: now - 7_200_000 });
    const newBuild = createFixture({ build: "B", generatedAt: now - 3_600_000 });
    const sharedCache = createMockCache();
    const startBuild = (f: Fixture) =>
      target === "cloudflare" ? startCloudflare(f, output, sharedCache) : start(target, f);

    const old = await startBuild(oldBuild);
    if (target === "cloudflare") open.push(old);
    await (await old.fetch(ISG_PATHS.page, { headers: { accept: "text/html" } })).text();
    await old.settle();
    expect(oldBuild.renders.get(ISG_PATHS.page)).toBe(1);

    const current = await startBuild(newBuild);
    if (target === "cloudflare") open.push(current);
    // A zone cache key can ignore the query string.
    const response = await current.fetch(`${ISG_PATHS.page}?utm=1`, {
      headers: { accept: "text/html" },
    });
    expect(await response.text()).not.toContain("render-of:A");
  },
);

// ---------------------------------------------------------------------------
// Revalidation webhook
// ---------------------------------------------------------------------------

const REVALIDATION_SCOPE: Partial<Record<TargetId, string>> = {
  node: "instance",
  cloudflare: "colo",
  netlify: "global",
  "vercel-edge": "global",
};

const REVALIDATION_CELLS = {
  node: run,
  cloudflare: run,
  netlify: run,
  "vercel-edge": run,
  "vercel-node": ISG_ONLY,
  "static-preview": NO_APP,
  dev: na("dev has no revalidation webhook"),
} satisfies Record<TargetId, Cell>;

async function revalidate(
  session: Session,
  paths: string[],
  token = REVALIDATE_TOKEN,
): Promise<Response> {
  return session.fetch("/__pracht/revalidate", {
    method: "POST",
    headers: { "content-type": "application/json", "x-pracht-revalidate-token": token },
    body: JSON.stringify({ paths }),
  });
}

/** Vercel revalidates by requesting the page from itself with a bypass token. */
function stubVercelSelfFetch(target: TargetId): void {
  if (target !== "vercel-edge") return;
  vi.stubGlobal("fetch", async () => new Response("ok", { status: 200 }));
}

row(
  "reports each path's outcome and the adapter's revalidation scope",
  REVALIDATION_CELLS,
  async (target) => {
    const session = await start(target);
    stubVercelSelfFetch(target);
    const response = await revalidate(session, [ISG_PATHS.page, "/", "/nope", ISG_PATHS.private]);
    expect(response.status).toBe(200);
    const report = (await response.json()) as {
      scope?: string;
      revalidated: string[];
      details: { path: string; outcome: string; reason?: string; scope?: string }[];
    };
    expect(report.scope).toBe(REVALIDATION_SCOPE[target]);
    expect(report.revalidated).toEqual([ISG_PATHS.page]);
    expect(
      Object.fromEntries(report.details.map((d) => [d.path, d.reason ?? d.scope ?? d.outcome])),
    ).toEqual({
      [ISG_PATHS.page]: REVALIDATION_SCOPE[target],
      "/": "not_isg",
      "/nope": "not_a_route",
      [ISG_PATHS.private]: "no_webhook_policy",
    });
  },
);

row("revalidates a page named with a trailing slash", REVALIDATION_CELLS, async (target) => {
  const session = await start(target);
  stubVercelSelfFetch(target);
  const response = await revalidate(session, [`${ISG_PATHS.page}/`]);
  const report = (await response.json()) as { revalidated: string[] };
  expect(report.revalidated).toEqual([`${ISG_PATHS.page}/`]);
});

row("rejects a revalidation request with a wrong token", REVALIDATION_CELLS, async (target) => {
  const session = await start(target);
  const response = await revalidate(session, [ISG_PATHS.page], "wrong");
  expect(response.status).toBe(401);
  expect(fixture.renders.get(ISG_PATHS.page)).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

/**
 * Divergent cells (`fails` plus `todo`) across the matrix. Converging a cell
 * means flipping it to `run` and lowering this number in the same change; a
 * new divergence is fixed, not recorded. 20 when the suite landed: 10 for
 * step C (ISG snapshots), 10 for step D (static paths, MIME, Range, 413).
 * Step C converged 7 and step D all 10. The last 3 converged after review:
 * Vercel answers a cookie or private render with a 503 its prerender cache
 * does not store, and Netlify's `index.html` alias is not a Netlify output.
 */
const BASELINE = 0;

describe("baseline", () => {
  it(`records exactly ${BASELINE} divergent cells`, () => {
    expect(divergences.map(({ row, target, step }) => `${step} ${target}: ${row}`)).toHaveLength(
      BASELINE,
    );
  });
});
