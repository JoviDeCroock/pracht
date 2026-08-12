import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { BuildOutputLogger, PrerenderedPageOutput } from "./build-static-output.js";

export interface BuildRoutePage extends PrerenderedPageOutput {
  headers?: Record<string, string>;
  markdown?: boolean;
}

export interface BuildIsgEntry {
  revalidate?: unknown;
}

export type BuildIsgManifest = Record<string, BuildIsgEntry>;

export interface BuildRouteOutput<TPage extends BuildRoutePage> {
  edgeCachedIsgPaths: string[];
  headersManifest: Record<string, Record<string, string>>;
  markdownManifest: Record<string, true>;
  staticPages: TPage[];
}

export function createBuildRouteOutput<TPage extends BuildRoutePage>(
  pages: readonly TPage[],
  isgManifest: BuildIsgManifest,
  options: { cloudflareWorkersCacheEnabled: boolean; netlifyIsgEnabled?: boolean },
): BuildRouteOutput<TPage> {
  const headersManifest: Record<string, Record<string, string>> = Object.fromEntries(
    pages.map((page) => [page.path, page.headers ?? {}]),
  );
  const markdownManifest: Record<string, true> = Object.fromEntries(
    pages.filter((page) => page.markdown).map((page) => [page.path, true]),
  );

  // An edge-cached, time-revalidated ISG route must reach the Worker on its
  // first request. A static snapshot would take precedence and never refresh.
  // Webhook-only ISG is not edge-cached and keeps its initial snapshot.
  const edgeCachedIsgPaths = options.cloudflareWorkersCacheEnabled
    ? Object.keys(isgManifest).filter((path) => hasTimeRevalidate(isgManifest[path]?.revalidate))
    : [];
  // Netlify serves every ISG path through the function and durable CDN cache.
  // Keeping a static snapshot would expose a permanently stale `/index.html`.
  const netlifyIsgPaths = options.netlifyIsgEnabled ? Object.keys(isgManifest) : [];
  const skippedSnapshotPaths = new Set([...edgeCachedIsgPaths, ...netlifyIsgPaths]);
  const staticPages =
    skippedSnapshotPaths.size > 0
      ? pages.filter((page) => !skippedSnapshotPaths.has(page.path))
      : [...pages];

  return { edgeCachedIsgPaths, headersManifest, markdownManifest, staticPages };
}

interface WriteBuildRouteManifestsOptions {
  buildTarget: string | null;
  clientDir: string;
  headersManifest: Record<string, Record<string, string>>;
  isgManifest: BuildIsgManifest;
  log: BuildOutputLogger;
  markdownManifest: Record<string, true>;
  root: string;
}

export function writeBuildRouteManifests(options: WriteBuildRouteManifestsOptions): void {
  const frameworkClientDir = resolve(options.clientDir, "_pracht");

  if (Object.keys(options.headersManifest).length > 0) {
    const headersManifestJson = serializeManifest(options.headersManifest);
    writeFileSync(
      resolve(options.root, "dist/server/headers-manifest.json"),
      headersManifestJson,
      "utf-8",
    );
    mkdirSync(frameworkClientDir, { recursive: true });
    writeFileSync(resolve(frameworkClientDir, "headers.json"), headersManifestJson, "utf-8");
  }

  // Always emit Markdown metadata. An absent file means "legacy/custom entry"
  // to adapters; `{}` is authoritative proof that no static route serves it.
  const markdownManifestJson = serializeManifest(options.markdownManifest);
  writeFileSync(
    resolve(options.root, "dist/server/markdown-manifest.json"),
    markdownManifestJson,
    "utf-8",
  );
  mkdirSync(frameworkClientDir, { recursive: true });
  writeFileSync(resolve(frameworkClientDir, "markdown.json"), markdownManifestJson, "utf-8");

  const isgRouteCount = Object.keys(options.isgManifest).length;
  if (isgRouteCount === 0) return;

  const isgManifestJson = serializeManifest(options.isgManifest);
  writeFileSync(resolve(options.root, "dist/server/isg-manifest.json"), isgManifestJson, "utf-8");
  if (options.buildTarget === "cloudflare") {
    // The Cloudflare worker reads this through its private asset binding. On
    // other targets dist/client is public, so publishing it would leak route
    // names and revalidation policy.
    writeFileSync(resolve(frameworkClientDir, "isg.json"), isgManifestJson, "utf-8");
  }
  options.log(`\n  ISG manifest → dist/server/isg-manifest.json (${isgRouteCount} route(s))\n`);
}

function serializeManifest(value: object): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// Mirrors getTimeRevalidateSeconds from @pracht/core without importing it:
// this CLI domain reads the manifest emitted by the built server bundle.
function hasTimeRevalidate(revalidate: unknown): boolean {
  const policies = Array.isArray(revalidate) ? revalidate : [revalidate];
  return policies.some(
    (policy) =>
      typeof policy === "object" &&
      policy !== null &&
      (policy as { kind?: unknown }).kind === "time" &&
      typeof (policy as { seconds?: unknown }).seconds === "number" &&
      (policy as { seconds: number }).seconds > 0,
  );
}
