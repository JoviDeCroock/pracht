/**
 * Self-contained devtools page for pracht dev mode, served at `/_pracht`.
 *
 * Returns a standalone HTML document with inline styles.
 * Not a Preact component — the page must render even when the app's own
 * module graph is broken, so it never imports Preact or app code.
 */

import type { AppGraph, AppGraphApiRoute, AppGraphRoute } from "./app-graph.ts";

export {
  buildAppGraph,
  detectApiExports,
  detectApiExportsStatic,
  detectApiMethods,
  serializeApiRoutes,
  serializeApiRoutesStatic,
  serializeAppRoutes,
  serializeCapabilities,
} from "./app-graph.ts";
export type {
  ApiRouteExports,
  AppGraph,
  AppGraphApiRoute,
  AppGraphCapability,
  AppGraphModuleAccess,
  AppGraphStaticModuleAccess,
  AppGraphRoute,
  SerializeApiRoutesOptions,
  SerializeCapabilitiesOptions,
} from "./app-graph.ts";

export const DEVTOOLS_PATH = "/_pracht";
export const DEVTOOLS_JSON_PATH = "/_pracht.json";

/**
 * One recorded capability dispatch, as the dev devtools show it. A flattened
 * projection of `CapabilityAuditEvent` plus the wall-clock time the dev server
 * observed it — the audit event itself carries no timestamp, because a
 * production sink stamps events with its own clock.
 */
export interface AgentTrafficEvent {
  /** Unix milliseconds, stamped when the dev server recorded the dispatch. */
  at: number;
  capability: string;
  effect: string;
  /** `"http" | "server" | "webmcp" | "mcp"` — how the dispatch arrived. */
  transport: string;
  /** Causal transport for nested `invokeCapability()` dispatches, else `null`. */
  via: string | null;
  /** `"ok"` or the envelope error code. */
  outcome: string;
  status: number;
  durationMs: number;
  /** Verified agent identity, `null` when unsigned or Web Bot Auth is off. */
  agent: { agentDomain: string | null; keyId: string } | null;
}

/** The `agentTraffic` field of `/_pracht.json`. */
export interface DevtoolsAgentTraffic {
  /** Ring-buffer capacity — older events past this count are dropped. */
  limit: number;
  /** Total dispatches observed since the dev server started; survives eviction. */
  recorded: number;
  /** Newest first, at most `limit` entries. */
  events: AgentTrafficEvent[];
}

export function buildDevtoolsHtml(
  graph: AppGraph,
  options: { base?: string; agentTraffic?: DevtoolsAgentTraffic } = {},
): string {
  const base = options.base ?? "/";
  const routeRows = graph.routes
    .map(
      (route) => `<tr>
        <td>${routeLinkHtml(route, base)}</td>
        <td>${escapeHtml(route.render ?? "ssr")}</td>
        <td>${escapeHtml(route.shell ?? "—")}</td>
        <td>${escapeHtml(route.middleware.length > 0 ? route.middleware.join(" → ") : "—")}</td>
        <td class="file">${escapeHtml(route.file)}</td>
      </tr>`,
    )
    .join("\n");

  const notFoundRow = graph.notFound
    ? `<tr>
        <td>${escapeHtml(graph.notFound.path)}</td>
        <td>404</td>
        <td>${escapeHtml(graph.notFound.shell ?? "—")}</td>
        <td>${escapeHtml(graph.notFound.middleware.length > 0 ? graph.notFound.middleware.join(" → ") : "—")}</td>
        <td class="file">${escapeHtml(graph.notFound.file)}</td>
      </tr>`
    : "";

  const apiRows = graph.api
    .map(
      (route) => `<tr>
        <td>${apiLinkHtml(route, base)}</td>
        <td>${escapeHtml(route.methods.length > 0 ? route.methods.join(", ") : "—")}</td>
        <td class="file">${escapeHtml(route.file)}</td>
      </tr>`,
    )
    .join("\n");

  const capabilityRows = (graph.capabilities ?? [])
    .map(
      (capability) => `<tr>
        <td>${escapeHtml(capability.name)}</td>
        <td>${escapeHtml(capability.effect ?? "—")}</td>
        <td>${escapeHtml(capability.transports.length > 0 ? capability.transports.join(", ") : "private")}</td>
        <td>${escapeHtml(capability.httpPath ?? "—")}</td>
        <td>${escapeHtml(capability.middleware.length > 0 ? capability.middleware.join(" → ") : "—")}</td>
        <td class="file">${escapeHtml(capability.source)}</td>
      </tr>`,
    )
    .join("\n");

  // Only rendered when the app registers capabilities — the devtools page is
  // byte-for-byte unchanged for apps that don't use them.
  const capabilitiesSection =
    (graph.capabilities ?? []).length > 0
      ? `<h2>Capabilities</h2>
    <table>
      <thead><tr><th>Name</th><th>Effect</th><th>Transports</th><th>HTTP path</th><th>Middleware</th><th>Source</th></tr></thead>
      <tbody>
${capabilityRows}
      </tbody>
    </table>`
      : "";

  const trafficEvents = options.agentTraffic?.events ?? [];
  const trafficKinds = trafficEvents.map(classifyAgentTraffic);
  const agentCount = trafficKinds.filter((kind) => kind === "agent").length;
  const unverifiedHttpCount = trafficKinds.filter((kind) => kind === "unverified-http").length;
  const composedCount = trafficKinds.filter((kind) => kind === "first-party").length;
  const droppedCount = Math.max(
    0,
    (options.agentTraffic?.recorded ?? trafficEvents.length) - trafficEvents.length,
  );

  const trafficRows = trafficEvents
    .map(
      (event) => `<tr${classifyAgentTraffic(event) === "first-party" ? ` class="composed"` : ""}>
        <td class="file">${escapeHtml(formatEventTime(event.at))}</td>
        <td>${escapeHtml(event.capability)}</td>
        <td>${escapeHtml(formatTransport(event))}</td>
        <td>${escapeHtml(event.effect)}</td>
        <td>${escapeHtml(formatAgent(event.agent))}</td>
        <td class="${event.outcome === "ok" ? "ok" : "err"}">${escapeHtml(formatOutcome(event))}</td>
        <td class="file">${escapeHtml(formatDuration(event.durationMs))}</td>
      </tr>`,
    )
    .join("\n");

  // First-party composition is hidden behind a CSS-only toggle rather than
  // dropped: on an app whose loaders compose capabilities it is the large
  // majority of dispatches, and leaving it in the default view buries the
  // handful of rows that answer "is anything external calling this?".
  const composedToggle =
    composedCount > 0
      ? `<input type="checkbox" id="pracht-show-composed" class="toggle-input">
    <label class="toggle" for="pracht-show-composed">Show ${composedCount} first-party <code>invokeCapability()</code> dispatch${composedCount === 1 ? "" : "es"}</label>
    `
      : "";

  const trafficTable = `${composedToggle}<table>
      <thead><tr><th>Time (UTC)</th><th>Capability</th><th>Transport</th><th>Effect</th><th>Agent</th><th>Outcome</th><th>Duration</th></tr></thead>
      <tbody>
${trafficRows}
      </tbody>
    </table>`;

  // Same rule as the capabilities table: an app with no capabilities has no
  // agent surface to observe, so its devtools page stays byte-for-byte
  // unchanged. Once capabilities exist the section is always present — an
  // empty traffic log is itself the answer to "are agents calling this?".
  const agentsSection =
    (graph.capabilities ?? []).length > 0
      ? `<h2>Agents${agentTrafficCaption(
          options.agentTraffic,
          agentCount,
          unverifiedHttpCount,
          composedCount,
        )}</h2>
    ${
      trafficEvents.length === 0
        ? `<p class="empty">No capability dispatches recorded yet. Call a capability over HTTP, WebMCP, or MCP and reload.</p>`
        : agentCount === 0 && unverifiedHttpCount === 0
          ? `<p class="empty">${
              droppedCount > 0
                ? "No agent-attributed traffic in the retained window. Older dropped dispatches may include agent traffic."
                : "No agent-attributed traffic yet — every recorded dispatch is this app calling itself."
            }</p>
    ${trafficTable}`
          : agentCount === 0
            ? `<p class="empty">No agent-attributed traffic in the retained window. Unverified HTTP dispatches may be people, agents, or other clients.</p>
    ${trafficTable}`
            : trafficTable
    }`
      : "";

  const apiSection =
    graph.api.length > 0
      ? `<h2>API routes</h2>
    <table>
      <thead><tr><th>Path</th><th>Methods</th><th>Source</th></tr></thead>
      <tbody>
${apiRows}
      </tbody>
    </table>`
      : `<h2>API routes</h2>
    <p class="empty">No API routes found.</p>`;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>pracht devtools</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: ui-monospace, "Cascadia Code", "Source Code Pro", Menlo, Consolas, monospace;
      background: #1a1a2e;
      color: #e0e0e0;
      padding: 32px;
      line-height: 1.5;
    }
    .devtools {
      max-width: 1100px;
      margin: 0 auto;
    }
    .header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid #333;
    }
    .badge {
      background: #4c6ef5;
      color: #fff;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 4px 10px;
      border-radius: 4px;
    }
    .title {
      font-size: 14px;
      color: #888;
    }
    .title a {
      color: #a0c4ff;
    }
    h2 {
      font-size: 14px;
      font-weight: 600;
      color: #a0c4ff;
      margin: 24px 0 10px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    th {
      text-align: left;
      color: #888;
      font-weight: 600;
      padding: 6px 12px 6px 0;
      border-bottom: 1px solid #333;
    }
    td {
      padding: 6px 12px 6px 0;
      border-bottom: 1px solid #26263e;
      vertical-align: top;
      word-break: break-word;
    }
    td a {
      color: #74c0fc;
    }
    .file {
      color: #888;
    }
    .ok {
      color: #8ce99a;
    }
    .err {
      color: #ffa8a8;
    }
    /* CSS-only disclosure: the page ships no JavaScript of its own. */
    .toggle-input {
      position: absolute;
      opacity: 0;
      pointer-events: none;
    }
    .toggle {
      display: inline-block;
      margin-bottom: 10px;
      font-size: 12px;
      color: #a0c4ff;
      cursor: pointer;
      border-bottom: 1px dotted #4c6ef5;
    }
    .toggle-input:focus-visible + .toggle {
      outline: 2px solid #4c6ef5;
      outline-offset: 2px;
    }
    tr.composed {
      display: none;
    }
    .toggle-input:checked ~ table tr.composed {
      display: table-row;
    }
    .empty {
      font-size: 13px;
      color: #888;
    }
    .hint {
      margin-top: 24px;
      font-size: 12px;
      color: #666;
    }
    .hint a {
      color: #a0c4ff;
    }
  </style>
</head>
<body>
  <div class="devtools">
    <div class="header">
      <span class="badge">pracht</span>
      <span class="title">devtools — resolved app graph (dev only)</span>
    </div>
    <h2>Page routes</h2>
    <table>
      <thead><tr><th>Route</th><th>Render</th><th>Shell</th><th>Middleware</th><th>Source</th></tr></thead>
      <tbody>
${routeRows}
${notFoundRow}
      </tbody>
    </table>
    ${apiSection}
    ${capabilitiesSection}
    ${agentsSection}
    <div class="hint">
      Raw JSON at <a href="${escapeHtml(withDevBase(DEVTOOLS_JSON_PATH, base))}">${DEVTOOLS_JSON_PATH}</a> ·
      same graph as <code>pracht inspect --json</code>, plus a dev-only
      <code>agentTraffic</code> log ·
      configured agent surface: <code>pracht inspect agents</code> ·
      per-request middleware/loader/render timings are on the <code>Server-Timing</code>
      response header in the browser Network panel.
    </div>
  </div>
</body>
</html>`;
}

/**
 * Classify a dispatch as agent-attributed, ambiguous unverified HTTP, or the
 * app composing its own capabilities.
 *
 * `transport: "server"` is `invokeCapability()`, which every loader and API
 * route can call — on a composing app it is the large majority of dispatches
 * and is not agent traffic at all. The one exception is a nested call composed
 * under a remote MCP request (`via: "mcp"`): that is trusted dispatch state, so
 * the effect really was agent-caused and belongs in the default view.
 *
 * Top-level unsigned HTTP is also ambiguous: Pracht's human `<Form capability>`
 * and browser client use the same endpoint as an HTTP agent. Keep those rows
 * visible, but never count them as agent-attributed without a verified identity
 * or an agent-specific transport marker.
 */
type AgentTrafficKind = "agent" | "unverified-http" | "first-party";

function classifyAgentTraffic(event: AgentTrafficEvent): AgentTrafficKind {
  if (
    event.agent !== null ||
    event.transport === "mcp" ||
    event.transport === "webmcp" ||
    event.via === "mcp"
  ) {
    return "agent";
  }
  if (event.transport === "http") return "unverified-http";
  return "first-party";
}

/**
 * `— 3 agent-attributed dispatches (mcp 3) · 3 unverified HTTP · 8 first-party
 * · 4 older dropped`. The separate unverified count prevents human form and
 * browser-client calls from masquerading as agent activation, and the dropped
 * count tells a reader that the visible log is only a tail.
 */
function agentTrafficCaption(
  traffic: DevtoolsAgentTraffic | undefined,
  agentCount: number,
  unverifiedHttpCount: number,
  composedCount: number,
): string {
  if (!traffic || traffic.recorded === 0) return "";

  const byTransport = new Map<string, number>();
  for (const event of traffic.events) {
    if (classifyAgentTraffic(event) !== "agent") continue;
    byTransport.set(event.transport, (byTransport.get(event.transport) ?? 0) + 1);
  }
  const breakdown = [...byTransport]
    .map(([transport, count]) => `${transport} ${count}`)
    .join(" · ");

  const parts = [`${agentCount} agent-attributed dispatch${agentCount === 1 ? "" : "es"}`];
  if (breakdown !== "") parts[0] += ` (${breakdown})`;
  if (unverifiedHttpCount > 0) {
    parts.push(`${unverifiedHttpCount} unverified HTTP`);
  }
  if (composedCount > 0) parts.push(`${composedCount} first-party`);
  const dropped = Math.max(0, traffic.recorded - traffic.events.length);
  if (dropped > 0) parts.push(`${dropped} older dropped`);

  return escapeHtml(` — ${parts.join(" · ")}`);
}

/** `HH:MM:SS.mmm` in UTC — stable across locales and trivially testable. */
function formatEventTime(at: number): string {
  return new Date(at).toISOString().slice(11, 23);
}

/**
 * A nested dispatch is rendered as `http → server`: the transport the request
 * arrived on, then the composed dispatch it caused.
 */
function formatTransport(event: AgentTrafficEvent): string {
  return event.via ? `${event.via} → ${event.transport}` : event.transport;
}

/**
 * In-process dispatch is routinely sub-millisecond; rounding those to `0ms`
 * reads as "not measured" rather than "fast".
 */
function formatDuration(durationMs: number): string {
  return durationMs < 1 ? "<1ms" : `${Math.round(durationMs)}ms`;
}

function formatOutcome(event: AgentTrafficEvent): string {
  return `${event.outcome} (${event.status})`;
}

function formatAgent(agent: AgentTrafficEvent["agent"]): string {
  if (!agent) return "—";
  return agent.agentDomain ?? agent.keyId;
}

function routeLinkHtml(route: AppGraphRoute, base: string): string {
  const label = escapeHtml(route.path);
  if (!isLinkablePath(route.path)) {
    return label;
  }

  return `<a href="${escapeHtml(withDevBase(route.path, base))}">${label}</a>`;
}

function apiLinkHtml(route: AppGraphApiRoute, base: string): string {
  const label = escapeHtml(route.path);
  if (!isLinkablePath(route.path) || !route.methods.includes("GET")) {
    return label;
  }

  return `<a href="${escapeHtml(withDevBase(route.path, base))}">${label}</a>`;
}

function withDevBase(path: string, base: string): string {
  if (base === "/" || !path.startsWith("/")) return path;
  const prefix = base.endsWith("/") ? base : `${base}/`;
  return `${prefix}${path.slice(1)}`;
}

/** Dynamic patterns (`:id`, `*`) are not navigable as-is — render them as text. */
function isLinkablePath(path: string): boolean {
  return !path.includes(":") && !path.includes("*");
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
