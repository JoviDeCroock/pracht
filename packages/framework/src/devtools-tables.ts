import type { AppGraph, AppGraphApiRoute, AppGraphRoute } from "./app-graph.ts";

export interface DevtoolsTableMarkup {
  routeRows: string;
  notFoundRow: string;
  apiSection: string;
  capabilitiesSection: string;
}

export function renderDevtoolsTables(graph: AppGraph): DevtoolsTableMarkup {
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

  return { apiSection, capabilitiesSection, notFoundRow, routeRows };
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
