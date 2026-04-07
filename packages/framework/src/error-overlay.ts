/**
 * Self-contained error overlay for viact dev mode.
 *
 * Returns a standalone HTML document with inline styles and scripts.
 * Not a Preact component — must render even when Preact itself fails.
 */

export interface ErrorOverlayOptions {
  message: string;
  stack?: string;
  routeId?: string;
  file?: string;
}

export function buildErrorOverlayHtml(options: ErrorOverlayOptions): string {
  const { message, stack, routeId, file } = options;

  const stackHtml = stack ? `<pre class="stack">${escapeHtml(stack)}</pre>` : "";

  const routeHtml = routeId
    ? `<div class="meta"><span class="label">Route</span> <span class="value">${escapeHtml(routeId)}</span></div>`
    : "";

  const fileHtml = file
    ? `<div class="meta"><span class="label">File</span> <span class="value">${escapeHtml(file)}</span></div>`
    : "";

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>viact error</title>
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
      background: #e74c3c;
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
    .message {
      font-size: 18px;
      font-weight: 600;
      color: #ff6b6b;
      margin-bottom: 20px;
      word-break: break-word;
    }
    .meta {
      font-size: 13px;
      margin-bottom: 6px;
    }
    .meta .label {
      color: #888;
      margin-right: 8px;
    }
    .meta .value {
      color: #a0c4ff;
    }
    .stack {
      background: #16162a;
      border: 1px solid #333;
      border-radius: 8px;
      padding: 20px;
      margin-top: 20px;
      font-size: 13px;
      line-height: 1.7;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-word;
      color: #ccc;
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
      <span class="badge">Error</span>
      <span class="title">viact dev</span>
    </div>
    <div class="message">${escapeHtml(message)}</div>
    ${routeHtml}
    ${fileHtml}
    ${stackHtml}
    <div class="hint">Fix the error and save — the page will reload automatically.</div>
  </div>
  <script>
    // Auto-reload when Vite triggers a full reload (e.g. file saved after fix)
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
