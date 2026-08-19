import type { GraphSnapshot } from "./graph-snapshot.js";
import { createCheck, type Check } from "./verification-helpers.js";

/**
 * Static-export preconditions, checked from the resolved app graph.
 *
 * `pracht build` already fails closed on every one of these, but only after
 * building both the client and server environments — and `pracht doctor` /
 * `pracht verify` previously reported "No blocking issues found" for an app
 * whose static build cannot succeed. The graph carries the same facts the
 * build validates (render mode, loaders, hydration, middleware, API routes,
 * capability transports), so the answer is available in about a second.
 *
 * Wording deliberately mirrors `validateStaticExport` in `build-static.ts`, so
 * a user who sees the check and then the build error reads the same sentence
 * twice rather than two descriptions of one problem.
 */
const SERVERFUL_ADAPTER_HINT =
  "Use @pracht/adapter-node, @pracht/adapter-cloudflare, or @pracht/adapter-vercel instead, " +
  'or change the route to render: "ssg" (or loaderless "spa" for client-only pages).';

function list(paths: string[]): string {
  return paths.join(", ");
}

export function collectStaticExportChecks(
  graph: GraphSnapshot,
  checks: Check[],
  options: {
    loaderRoutePaths?: ReadonlySet<string>;
    staticTarget: boolean;
  },
): void {
  if (!options.staticTarget) return;

  // The graph snapshot carries routes, API routes, and capabilities, but not
  // the app-level notFound page. Its two static-export rules (full hydration,
  // no middleware) stay build-time-only checks rather than growing the
  // snapshot format for them.
  const routes = graph.routes ?? [];
  let problems = 0;

  // A missing render mode defaults to SSR at request time.
  const serverRendered = routes.filter((route) => route.render !== "ssg" && route.render !== "spa");
  if (serverRendered.length > 0) {
    problems += 1;
    checks.push(
      createCheck(
        "error",
        `Static export: these routes render on a server at request time, but a static export has no server: ` +
          `${list(serverRendered.map((route) => `${route.path} (render: "${route.render ?? "ssr"}")`))}. ` +
          SERVERFUL_ADAPTER_HINT,
      ),
    );
  }

  const spaWithLoaders = routes.filter((route) => {
    if (route.render !== "spa") return false;
    return options.loaderRoutePaths
      ? options.loaderRoutePaths.has(route.path)
      : route.loaderFile !== null;
  });
  if (spaWithLoaders.length > 0) {
    problems += 1;
    checks.push(
      createCheck(
        "error",
        `Static export: these SPA routes declare server loaders, but a static host cannot run them at request time: ` +
          `${list(spaWithLoaders.map((route) => route.path))}. ` +
          "Static SPA routes must be loaderless. Fetch live data from the browser, change the route to SSG " +
          "for build-time data, or use a serverful adapter.",
      ),
    );
  }

  const spaWithNonFullHydration = routes.filter(
    (route) => route.render === "spa" && route.hydration !== null && route.hydration !== "full",
  );
  if (spaWithNonFullHydration.length > 0) {
    problems += 1;
    checks.push(
      createCheck(
        "error",
        `Static export: these SPA routes use non-full hydration, but SPA components render entirely in the browser: ` +
          `${list(
            spaWithNonFullHydration.map(
              (route) => `${route.path} (hydration: "${route.hydration}")`,
            ),
          )}. ` +
          'Remove the hydration option (or set it to "full"), change the route to SSG, or use a serverful adapter.',
      ),
    );
  }

  const routesWithMiddleware = routes.filter((route) => route.middleware.length > 0);
  if (routesWithMiddleware.length > 0) {
    problems += 1;
    checks.push(
      createCheck(
        "error",
        `Static export: these routes use request middleware, but a static host has no request runtime to enforce it: ` +
          `${list(routesWithMiddleware.map((route) => route.path))}. ` +
          "Remove the route middleware or use a serverful adapter.",
      ),
    );
  }

  const apiRoutes = graph.api ?? [];
  if (apiRoutes.length > 0) {
    problems += 1;
    checks.push(
      createCheck(
        "error",
        `Static export: API routes need a server to answer requests, but a static export has none: ` +
          `${list(apiRoutes.map((route) => route.path))}. ` +
          "Remove them or use a serverful adapter.",
      ),
    );
  }

  const exposedCapabilities = (graph.capabilities ?? []).filter(
    (capability) => capability.transports.length > 0,
  );
  if (exposedCapabilities.length > 0) {
    problems += 1;
    checks.push(
      createCheck(
        "error",
        `Static export: these capabilities are exposed over the network, but a static export has no server to serve them: ` +
          `${list(
            exposedCapabilities.map(
              (capability) => `${capability.name} (${capability.transports.join(", ")})`,
            ),
          )}. ` +
          "Server-only capabilities invoked from build-time loaders are fine.",
      ),
    );
  }

  if (problems === 0) {
    checks.push(
      createCheck("ok", "Static export preconditions hold (no request-runtime features in use)."),
    );
  }
}
