/**
 * Self-contained 404 page for pracht dev mode.
 *
 * Returns a standalone HTML document with inline styles and scripts.
 * Not a Preact component — rendered by the dev middleware when a request
 * matches no page route and no API route. Loaded exclusively through the
 * dev server (`@pracht/core/dev-404`) and never reachable from production
 * code paths.
 */

export interface DevNotFoundRoute {
  path: string;
  render?: string | null;
}

export interface DevNotFoundApiRoute {
  path: string;
  methods?: string[];
}

export interface DevNotFoundOptions {
  requestedPath: string;
  routes: DevNotFoundRoute[];
  apiRoutes?: DevNotFoundApiRoute[];
}

const DYNAMIC_SEGMENT = /[:*]/;

export function buildDevNotFoundHtml(options: DevNotFoundOptions): string {
  const { requestedPath, routes, apiRoutes = [] } = options;

  const routeRows = routes
    .map((route) => {
      const mode = route.render ?? "ssr";
      const isLinkable = !DYNAMIC_SEGMENT.test(route.path);
      const pathCell = isLinkable
        ? `<a class="path" href="${escapeHtml(route.path)}">${escapeHtml(route.path)}</a>`
        : `<span class="path dynamic">${escapeHtml(route.path)}</span>`;
      return `<tr><td>${pathCell}</td><td><span class="mode mode-${escapeHtml(mode)}">${escapeHtml(mode)}</span></td></tr>`;
    })
    .join("\n      ");

  const routesHtml =
    routes.length > 0
      ? `<table class="routes">\n      ${routeRows}\n    </table>`
      : `<p class="empty">No page routes are registered.</p>`;

  const apiRows = apiRoutes
    .map((route) => {
      const methods = route.methods?.length ? route.methods.join(", ") : "";
      return `<tr><td><span class="path">${escapeHtml(route.path)}</span></td><td><span class="methods">${escapeHtml(methods)}</span></td></tr>`;
    })
    .join("\n      ");

  const apiHtml =
    apiRoutes.length > 0
      ? `<h2>API routes</h2>\n    <table class="routes">\n      ${apiRows}\n    </table>`
      : "";

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>404 — pracht dev</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: ui-monospace, "Cascadia Code", "Source Code Pro", Menlo, Consolas, monospace;
      background: #1a1a2e;
      color: #e0e0e0;
      padding: 32px;
      line-height: 1.5;
    }
    .overlay {
      max-width: 900px;
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
      background: #f39c12;
      color: #1a1a2e;
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
    .message {
      font-size: 18px;
      font-weight: 600;
      color: #ffd166;
      margin-bottom: 8px;
      word-break: break-word;
    }
    .requested {
      color: #a0c4ff;
    }
    .sub {
      font-size: 13px;
      color: #888;
      margin-bottom: 28px;
    }
    h2 {
      font-size: 13px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #888;
      margin: 28px 0 10px;
    }
    .routes {
      width: 100%;
      border-collapse: collapse;
      background: #16162a;
      border: 1px solid #333;
      border-radius: 8px;
      overflow: hidden;
      font-size: 13px;
    }
    .routes td {
      padding: 8px 16px;
      border-bottom: 1px solid #262640;
    }
    .routes tr:last-child td {
      border-bottom: none;
    }
    .routes td:last-child {
      text-align: right;
      width: 1%;
      white-space: nowrap;
    }
    a.path {
      color: #a0c4ff;
      text-decoration: none;
    }
    a.path:hover {
      text-decoration: underline;
    }
    .path.dynamic {
      color: #ccc;
    }
    .mode {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 2px 8px;
      border-radius: 4px;
      background: #262640;
      color: #a0c4ff;
    }
    .mode-ssg { color: #7bd88f; }
    .mode-isg { color: #5fd7d7; }
    .mode-ssr { color: #ffd166; }
    .mode-spa { color: #d7a0ff; }
    .methods {
      font-size: 12px;
      color: #7bd88f;
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
  </style>
</head>
<body>
  <div class="overlay">
    <div class="header">
      <span class="badge">404</span>
      <span class="title">pracht dev</span>
    </div>
    <div class="message">No route matches <span class="requested">${escapeHtml(requestedPath)}</span></div>
    <div class="sub">This page is only shown in development — production serves your app's own 404 response.</div>
    <h2>Page routes</h2>
    ${routesHtml}
    ${apiHtml}
    <div class="hint">Add the route to your app manifest and save — the page will reload automatically.</div>
  </div>
  <script>
    // Auto-reload when Vite triggers a full reload (e.g. a route was added)
    if (import.meta.hot) {
      import.meta.hot.on("vite:beforeFullReload", function () {
        window.location.reload();
      });
    }
  </script>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
