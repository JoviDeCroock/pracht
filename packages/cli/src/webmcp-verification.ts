import type { AppGraph, AppGraphCapability, AppGraphRoute } from "@pracht/core";

import { collectAppGraph } from "./app-graph.js";
import { withAppServer } from "./app-server.js";
import {
  launchWebmcpBrowser,
  navigateWebmcpPage,
  readWebmcpSupport,
  waitForBrowserTools,
  type BrowserInfo,
  type BrowserToolDescriptor,
  type WebmcpBrowserSession,
} from "./webmcp-browser.js";

export type WebmcpVerificationStatus =
  | "passed"
  | "unsupported"
  | "app-graph-failure"
  | "browser-startup-failure"
  | "registration-failure"
  | "drift";

export interface ExpectedWebmcpTool {
  annotations: { readOnlyHint: boolean };
  description: string;
  inputSchema: Record<string, unknown> | null;
  name: string;
  title: string;
}

export interface WebmcpMismatch {
  actual?: unknown;
  expected?: unknown;
  field?: string;
  kind: "descriptor" | "missing" | "route" | "unexpected";
  tool?: string;
}

export interface WebmcpRouteResult {
  expectedTools: ExpectedWebmcpTool[];
  mismatches: WebmcpMismatch[];
  navigation: "client" | "document";
  observedTools: BrowserToolDescriptor[];
  route: string;
  url: string;
}

export interface WebmcpVerificationReport {
  browser: BrowserInfo | null;
  error: string | null;
  ok: boolean;
  routes: WebmcpRouteResult[];
  status: WebmcpVerificationStatus;
  support: { methods: string[] } | null;
}

interface WebmcpRouteCase {
  expectedTools: ExpectedWebmcpTool[];
  path: string;
  route: string;
}

export async function runWebmcpVerification(
  root: string,
  options: {
    baseUrl: string;
    browser?: WebmcpBrowserSession;
    browserExecutable?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<WebmcpVerificationReport> {
  let graph: AppGraph;
  try {
    graph = await withAppServer(root, ({ project, server }) =>
      collectAppGraph(server, root, { appFile: project.appFile }),
    );
  } catch (error) {
    return failedReport(
      "app-graph-failure",
      `Could not resolve the expected app graph: ${describeError(error)}`,
    );
  }

  const routeCases = webmcpRouteCases(graph);
  if (routeCases.length === 0) {
    return {
      browser: null,
      error: null,
      ok: true,
      routes: [],
      status: "passed",
      support: null,
    };
  }

  let browser = options.browser;
  let ownsBrowser = false;
  let abortListener: (() => void) | undefined;
  try {
    if (options.signal?.aborted) {
      return failedReport("browser-startup-failure", "WebMCP verification was cancelled.");
    }
    if (!browser) {
      try {
        browser = await launchWebmcpBrowser({
          executable: options.browserExecutable,
          timeoutMs: options.timeoutMs,
        });
        ownsBrowser = true;
      } catch (error) {
        return failedReport(
          "browser-startup-failure",
          `Could not start a compatible browser: ${describeError(error)}`,
        );
      }
    }
    if (options.signal) {
      abortListener = () => void browser?.close();
      options.signal.addEventListener("abort", abortListener, { once: true });
    }

    const routes: WebmcpRouteResult[] = [];
    let supportMethods: string[] | null = null;
    for (const routeCase of routeCases) {
      const url = new URL(routeCase.path, ensureTrailingSlash(options.baseUrl)).toString();
      let navigation: "client" | "document";
      try {
        navigation = await navigateWebmcpPage(browser.page, url, browser.timeoutMs);
      } catch (error) {
        return {
          browser: browser.info,
          error: `Could not navigate to ${url}: ${describeError(error)}`,
          ok: false,
          routes,
          status: "registration-failure",
          support: supportMethods ? { methods: supportMethods } : null,
        };
      }

      const support = await readWebmcpSupport(browser.page).catch((error) => ({
        available: false,
        detail: `Checking document.modelContext failed: ${describeError(error)}`,
        methods: [],
      }));
      supportMethods = support.methods;
      if (!support.available) {
        return {
          browser: browser.info,
          error:
            `${support.detail ?? "The WebMCP API is unavailable."} ` +
            "Install Chrome 150+ or pass a compatible pinned executable with --browser.",
          ok: false,
          routes,
          status: "unsupported",
          support: { methods: support.methods },
        };
      }

      let observedTools: BrowserToolDescriptor[];
      try {
        observedTools = await waitForBrowserTools(
          browser.page,
          routeCase.expectedTools.map((tool) => tool.name),
          Math.min(options.timeoutMs ?? 10_000, 3_000),
        );
      } catch (error) {
        return {
          browser: browser.info,
          error: `The browser WebMCP registry failed on ${routeCase.route}: ${describeError(error)}`,
          ok: false,
          routes,
          status: "registration-failure",
          support: { methods: support.methods },
        };
      }

      const actualPath = new URL(browser.page.url()).pathname;
      const mismatches = compareWebmcpTools(routeCase.expectedTools, observedTools);
      if (actualPath !== routeCase.path) {
        mismatches.unshift({
          actual: actualPath,
          expected: routeCase.path,
          kind: "route",
        });
      }
      routes.push({
        expectedTools: routeCase.expectedTools,
        mismatches,
        navigation,
        observedTools,
        route: routeCase.route,
        url,
      });
    }

    const ok = routes.every((route) => route.mismatches.length === 0);
    return {
      browser: browser.info,
      error: ok ? null : "The live WebMCP registry differs from the resolved capability graph.",
      ok,
      routes,
      status: ok ? "passed" : "drift",
      support: { methods: supportMethods ?? [] },
    };
  } finally {
    if (abortListener) options.signal?.removeEventListener("abort", abortListener);
    if (ownsBrowser) await browser?.close();
  }
}

export function webmcpRouteCases(graph: AppGraph): WebmcpRouteCase[] {
  const capabilities = new Map(
    graph.capabilities
      .filter((capability) => capability.transports.includes("webmcp"))
      .map((capability) => [capability.name, capability]),
  );
  const active = graph.routes.filter((route) =>
    route.capabilities?.some((name) => capabilities.has(name)),
  );
  if (active.length === 0) return [];

  // End on a neutral route when one exists. Comparing that empty live registry
  // after client navigation proves route-owned AbortSignals removed old tools.
  const neutral = graph.routes.find(
    (route) => !route.capabilities?.some((name) => capabilities.has(name)),
  );
  return [...active, ...(neutral ? [neutral] : [])].map((route) => ({
    expectedTools: expectedToolsForRoute(route, capabilities),
    path: concreteRoutePath(route.path),
    route: route.path,
  }));
}

export function compareWebmcpTools(
  expected: readonly ExpectedWebmcpTool[],
  observed: readonly BrowserToolDescriptor[],
): WebmcpMismatch[] {
  const mismatches: WebmcpMismatch[] = [];
  const expectedByName = new Map(expected.map((tool) => [tool.name, tool]));
  const observedByName = new Map(observed.map((tool) => [tool.name, tool]));

  for (const tool of expected) {
    const actual = observedByName.get(tool.name);
    if (!actual) {
      mismatches.push({ expected: tool, kind: "missing", tool: tool.name });
      continue;
    }
    compareField(mismatches, tool.name, "title", tool.title, actual.title);
    compareField(mismatches, tool.name, "description", tool.description, actual.description);
    compareField(mismatches, tool.name, "inputSchema", tool.inputSchema, actual.inputSchema);
    compareField(
      mismatches,
      tool.name,
      "annotations.readOnlyHint",
      tool.annotations.readOnlyHint,
      actual.annotations.readOnlyHint,
    );
  }
  for (const tool of observed) {
    if (!expectedByName.has(tool.name)) {
      mismatches.push({ actual: tool, kind: "unexpected", tool: tool.name });
    }
  }
  return mismatches;
}

function expectedToolsForRoute(
  route: AppGraphRoute,
  capabilities: ReadonlyMap<string, AppGraphCapability>,
): ExpectedWebmcpTool[] {
  return (route.capabilities ?? [])
    .map((name) => capabilities.get(name))
    .filter((capability): capability is AppGraphCapability => Boolean(capability))
    .map((capability) => ({
      annotations: { readOnlyHint: capability.effect === "read" },
      description: capability.description ?? "",
      inputSchema: capability.input,
      name: capability.name,
      title: capability.title ?? "",
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** Produce a deterministic concrete URL for dynamic and catch-all dev routes. */
export function concreteRoutePath(pattern: string): string {
  return pattern
    .replace(/:([A-Za-z0-9_]+)\*/g, "pracht-webmcp/path")
    .replace(/:([A-Za-z0-9_]+)/g, "pracht-webmcp")
    .replace(/\*/g, "pracht-webmcp/path");
}

function compareField(
  mismatches: WebmcpMismatch[],
  tool: string,
  field: string,
  expected: unknown,
  actual: unknown,
): void {
  if (stableJson(expected) === stableJson(actual)) return;
  mismatches.push({ actual, expected, field, kind: "descriptor", tool });
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJson(entry)]),
  );
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function failedReport(
  status: Extract<WebmcpVerificationStatus, "app-graph-failure" | "browser-startup-failure">,
  error: string,
): WebmcpVerificationReport {
  return { browser: null, error, ok: false, routes: [], status, support: null };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
