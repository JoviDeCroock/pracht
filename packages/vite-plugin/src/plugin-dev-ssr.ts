import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { Connect, ViteDevServer } from "vite";
import type { PrachtPhaseTimings, ResolvedApiRoute, ResolvedPrachtApp } from "@pracht/core";
import { applyDefaultSecurityHeaders } from "@pracht/core";
import {
  CLIENT_BROWSER_PATH,
  ISLANDS_CLIENT_BROWSER_PATH,
  PRACHT_SERVER_MODULE_ID,
} from "./plugin-assets.ts";
import { DEVTOOLS_JSON_PATH, DEVTOOLS_PATH, serveDevtools } from "./plugin-devtools.ts";
import {
  isDevNotFoundRequest,
  matchesResolvedRoute,
  shouldBypassDevSSR,
} from "./plugin-dev-routing.ts";
import { handleDevError, serveDevNotFound } from "./plugin-dev-responses.ts";
import {
  DEFAULT_DEV_MAX_BODY_SIZE,
  DevRequestBodyTooLargeError,
  nodeToWebRequest,
} from "./plugin-dev-request.ts";

const BODYLESS_METHODS = new Set(["GET", "HEAD"]);

export {
  collectDevCssUrls,
  createDevCssInjectionMiddleware,
  createDevCssManifest,
  injectDevCssForPath,
  injectDevCssLinks,
} from "./plugin-dev-css.ts";
export { DEVTOOLS_JSON_PATH, DEVTOOLS_PATH } from "./plugin-devtools.ts";
export { isDevNotFoundRequest, shouldBypassDevSSR } from "./plugin-dev-routing.ts";

export const LLMS_TXT_PATH = "/llms.txt";

export function createDevSSRMiddleware(
  server: ViteDevServer,
  options: { maxBodySize?: number; llmsTxt?: boolean } = {},
): Connect.NextHandleFunction {
  const maxBodySize = options.maxBodySize ?? DEFAULT_DEV_MAX_BODY_SIZE;
  let warnedDevtoolsCollision = false;
  let warnedLlmsTxtCollision = false;

  // A hand-written public/llms.txt and the generated one disagree about who
  // wins: Vite's publicDir middleware serves the static file in dev (before
  // this handler runs), while `pracht build` overwrites it with generated
  // content. Warn once so the divergence is not silent.
  if (options.llmsTxt && typeof server.config.publicDir === "string") {
    const publicLlmsTxt = join(server.config.publicDir, "llms.txt");
    if (existsSync(publicLlmsTxt)) {
      server.config.logger.warn(
        `[pracht] Both public/llms.txt and the pracht({ llmsTxt }) option are present. ` +
          `Dev serves the static public/llms.txt, but "pracht build" overwrites it with the ` +
          `generated content. Remove one to avoid a dev/production mismatch.`,
      );
    }
  }
  return async (req: IncomingMessage, res: ServerResponse, next: Connect.NextFunction) => {
    const url = req.url ?? "/";
    const requestUrl = new URL(url, "http://localhost");

    try {
      const [framework, serverMod] = await Promise.all([
        server.ssrLoadModule("@pracht/core/server"),
        server.ssrLoadModule(PRACHT_SERVER_MODULE_ID),
      ]);

      const routeMatchers = {
        app: serverMod.resolvedApp as ResolvedPrachtApp,
        apiRoutes: serverMod.apiRoutes as ResolvedApiRoute[],
        matchApiRoute: framework.matchApiRoute,
        matchAppRoute: framework.matchAppRoute,
      };

      // `/_pracht` is reserved in dev only. Production builds never see this
      // branch, so a user route at that path keeps working in production.
      if (requestUrl.pathname === DEVTOOLS_PATH || requestUrl.pathname === DEVTOOLS_JSON_PATH) {
        if (!warnedDevtoolsCollision && matchesResolvedRoute(requestUrl.pathname, routeMatchers)) {
          warnedDevtoolsCollision = true;
          server.config.logger.warn(
            `[pracht] An app route matches ${requestUrl.pathname}, which is reserved for the ` +
              `pracht devtools page in dev. The devtools page wins during development; the app ` +
              `route is only served in production builds.`,
          );
        }

        await serveDevtools(server, res, {
          apiRoutes: serverMod.apiRoutes ?? [],
          app: serverMod.resolvedApp,
          url,
          wantsJson: requestUrl.pathname === DEVTOOLS_JSON_PATH,
        });
        return;
      }

      // `/llms.txt` is served from the live app graph when the plugin's
      // `llmsTxt` option is enabled — the same content `pracht build` writes
      // to dist/client/llms.txt.
      if (
        options.llmsTxt &&
        requestUrl.pathname === LLMS_TXT_PATH &&
        BODYLESS_METHODS.has((req.method ?? "GET").toUpperCase()) &&
        typeof serverMod.generateLlmsTxt === "function"
      ) {
        if (!warnedLlmsTxtCollision && matchesResolvedRoute(LLMS_TXT_PATH, routeMatchers)) {
          warnedLlmsTxtCollision = true;
          server.config.logger.warn(
            `[pracht] An app route matches ${LLMS_TXT_PATH}, which is reserved by the ` +
              `pracht({ llmsTxt }) option. The generated llms.txt wins; disable the option ` +
              `to serve the app route instead.`,
          );
        }

        const llmsTxt: string = await serverMod.generateLlmsTxt();
        res.statusCode = 200;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        // Match production: the adapters serve dist/client/llms.txt with the
        // framework's default security headers, and dev diverging from that is
        // exactly the kind of difference that only shows up after deploy.
        applyDefaultSecurityHeaders(new Headers()).forEach((value, key) => {
          res.setHeader(key, value);
        });
        res.end(llmsTxt);
        return;
      }

      if (shouldBypassDevSSR(requestUrl, req, routeMatchers)) {
        return next();
      }

      if (isDevNotFoundRequest(requestUrl, req, routeMatchers)) {
        return serveDevNotFound(server, res, next, url, requestUrl.pathname, routeMatchers);
      }

      let webRequest: Request;
      try {
        webRequest = await nodeToWebRequest(req, maxBodySize);
      } catch (err) {
        if (err instanceof DevRequestBodyTooLargeError) {
          res.statusCode = 413;
          res.end("Payload Too Large");
          return;
        }
        throw err;
      }
      // Dev-only: collect middleware/loader/render phase durations so the
      // browser Network panel shows them via the Server-Timing header.
      const timings: PrachtPhaseTimings = {};
      const response = await framework.handlePrachtRequest({
        app: serverMod.resolvedApp,
        registry: serverMod.registry,
        request: webRequest,
        debugErrors: true,
        clientEntryUrl: CLIENT_BROWSER_PATH,
        islandsEntryUrl: ISLANDS_CLIENT_BROWSER_PATH,
        islandsBootstrapRequired: serverMod.islandsBootstrapRequired === true,
        apiRoutes: serverMod.apiRoutes,
        timings,
      });

      // A 404 from the runtime normally falls through to Vite (which has
      // already had its shot at static files, since this middleware is
      // installed after Vite's own). Two exceptions are served as-is: apps
      // that declare a `notFound` page get that page rendered here — same as
      // in production — and JSON 404s are typed API responses (route-state,
      // capability envelopes) that must reach the client untouched.
      const responseContentType = response.headers.get("content-type") ?? "";
      if (
        response.status === 404 &&
        !responseContentType.includes("application/json") &&
        !routeMatchers.app?.notFound
      ) {
        return next();
      }

      // Only transform what actually is HTML. Defaulting a missing
      // content-type to `text/html` made Vite inject its client script into
      // bodiless responses — an MCP `notifications/*` 202 came back with
      // `<script type="module" src="/@vite/client">` as its body, and so did
      // redirects.
      const contentType = response.headers.get("content-type") ?? "";
      let body = await response.text();

      if (contentType.includes("text/html")) {
        body = await server.transformIndexHtml(url, body);
      }

      res.statusCode = response.status;
      response.headers.forEach((value: string, key: string) => {
        res.setHeader(key, value);
      });
      const serverTiming = framework.formatServerTimingHeader(timings);
      if (serverTiming) {
        res.setHeader("Server-Timing", serverTiming);
      }
      res.end(body);
    } catch (error: unknown) {
      await handleDevError(server, req, res, next, url, error);
    }
  };
}
