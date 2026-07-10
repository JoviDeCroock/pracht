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
  detectApiMethods,
  serializeApiRoutes,
  serializeAppRoutes,
  serializeCapabilities,
} from "./app-graph.ts";
export type {
  AppGraph,
  AppGraphApiRoute,
  AppGraphCapability,
  AppGraphModuleAccess,
  AppGraphRoute,
} from "./app-graph.ts";

export const DEVTOOLS_PATH = "/_pracht";
export const DEVTOOLS_JSON_PATH = "/_pracht.json";

export function buildDevtoolsHtml(graph: AppGraph): string {
  const routeRows = graph.routes
    .map(
      (route) => `<tr>
        <td>${routeLinkHtml(route)}</td>
        <td>${escapeHtml(route.render ?? "ssr")}</td>
        <td>${escapeHtml(route.shell ?? "—")}</td>
        <td>${escapeHtml(route.middleware.length > 0 ? route.middleware.join(" → ") : "—")}</td>
        <td class="file">${escapeHtml(route.file)}</td>
      </tr>`,
    )
    .join("\n");

  const apiRows = graph.api
    .map(
      (route) => `<tr>
        <td>${apiLinkHtml(route)}</td>
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
      </tbody>
    </table>
    ${apiSection}
    ${capabilitiesSection}
    <div class="hint">
      Raw JSON at <a href="${DEVTOOLS_JSON_PATH}">${DEVTOOLS_JSON_PATH}</a> ·
      same data as <code>pracht inspect --json</code> ·
      per-request middleware/loader/render timings are on the <code>Server-Timing</code>
      response header in the browser Network panel.
    </div>
  </div>
</body>
</html>`;
}

function routeLinkHtml(route: AppGraphRoute): string {
  const label = escapeHtml(route.path);
  if (!isLinkablePath(route.path)) {
    return label;
  }

  return `<a href="${escapeHtml(route.path)}">${label}</a>`;
}

function apiLinkHtml(route: AppGraphApiRoute): string {
  const label = escapeHtml(route.path);
  if (!isLinkablePath(route.path) || !route.methods.includes("GET")) {
    return label;
  }

  return `<a href="${escapeHtml(route.path)}">${label}</a>`;
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
