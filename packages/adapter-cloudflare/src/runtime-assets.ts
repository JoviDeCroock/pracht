/** Cloudflare asset-binding lookup and route-manifest response policy. */

import {
  applyDefaultSecurityHeaders,
  type MarkdownManifest,
  prefersMarkdown,
  routeSupportsMarkdown,
} from "@pracht/core/server";
import type { CloudflareFetcher, HeadersManifest } from "./runtime-types.ts";

export async function maybeServeAsset(
  request: Request,
  env: Record<string, unknown>,
  assetsBinding: string,
  headersManifest: HeadersManifest = {},
  markdownManifest?: MarkdownManifest,
): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return null;
  }

  // The handler short-circuits upgrades before reaching here; this keeps the
  // guarantee local, so no future caller can forward a handshake to a Fetcher.
  if (request.headers.has("upgrade")) {
    return null;
  }

  const url = new URL(request.url);
  if (
    request.headers.get("x-pracht-route-state-request") === "1" ||
    url.searchParams.get("_data") === "1"
  ) {
    return null;
  }

  if (wantsRouteMarkdown(request, markdownManifest, url.pathname)) {
    return null;
  }

  const assets = env[assetsBinding];
  if (!isFetcher(assets)) {
    return null;
  }

  const response = await assets.fetch(request);
  if (response.status === 404) return null;

  const headers = new Headers(response.headers);
  headers.append("Vary", "x-pracht-route-state-request");
  applyDefaultSecurityHeaders(headers);
  if ((headers.get("content-type") ?? "").includes("text/html")) {
    applyHeadersManifest(headers, headersManifest, url.pathname);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function applyHeadersManifest(
  headers: Headers,
  headersManifest: HeadersManifest,
  pathname: string,
): void {
  const routeHeaders = getManifestHeaders(headersManifest, pathname);
  if (!routeHeaders) return;

  for (const [key, value] of Object.entries(routeHeaders)) {
    headers.set(key, value);
  }
}

function getManifestHeaders(
  headersManifest: HeadersManifest,
  pathname: string,
): Record<string, string> | undefined {
  const withoutIndex = pathname.replace(/\/index\.html$/, "") || "/";
  const withoutSlash = pathname.replace(/\/$/, "") || "/";
  return (
    headersManifest[pathname] ?? headersManifest[withoutSlash] ?? headersManifest[withoutIndex]
  );
}

/**
 * A request may only skip the assets binding / edge cache when it explicitly
 * prefers markdown over HTML and the build's exact markdown manifest includes
 * the route. Missing metadata means a legacy/custom entry, so preserve correct
 * negotiation by falling through as older adapters did.
 */
function wantsRouteMarkdown(
  request: Request,
  markdownManifest: MarkdownManifest | undefined,
  pathname: string,
): boolean {
  return (
    prefersMarkdown(request.headers.get("accept")) &&
    (markdownManifest === undefined || routeSupportsMarkdown(markdownManifest, pathname))
  );
}

function isFetcher(value: unknown): value is CloudflareFetcher {
  return typeof value === "object" && value !== null && "fetch" in value;
}

export function isDocumentAssetRequest(
  request: Request,
  markdownManifest: MarkdownManifest | undefined,
): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;

  const url = new URL(request.url);
  if (
    request.headers.get("x-pracht-route-state-request") === "1" ||
    url.searchParams.get("_data") === "1"
  ) {
    return false;
  }

  return !wantsRouteMarkdown(request, markdownManifest, url.pathname);
}
