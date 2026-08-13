import { resolveEditorFilePath } from "./editor-path.ts";
import type { ErrorOverlayOptions, StackFrame } from "./model.ts";
import { parseStackFrames } from "./stack.ts";

export function buildErrorOverlayHtml(options: ErrorOverlayOptions): string {
  const { message, stack, routeId, file, root } = options;

  const stackHtml = stack
    ? `<pre class="stack">${renderStackFrames(parseStackFrames(stack, { root }))}</pre>`
    : "";

  const routeHtml = routeId
    ? `<div class="meta"><span class="label">Route</span> <span class="value">${escapeHtml(routeId)}</span></div>`
    : "";

  const fileHtml = file
    ? `<div class="meta"><span class="label">File</span> ${renderFileValue(file, root)}</div>`
    : "";

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>pracht error</title>
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
    .frame-internal {
      opacity: 0.45;
    }
    .editor-link {
      color: #a0c4ff;
      text-decoration: underline;
      text-decoration-style: dotted;
      text-underline-offset: 3px;
      cursor: pointer;
    }
    .editor-link:hover {
      color: #d0e2ff;
      text-decoration-style: solid;
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
      <span class="title">pracht dev</span>
    </div>
    <div class="message">${escapeHtml(message)}</div>
    ${routeHtml}
    ${fileHtml}
    ${stackHtml}
    <div class="hint">Click a stack frame to open it in your editor. Fix the error and save — the page will reload automatically.</div>
  </div>
  <script>
    // Open clicked stack frames in the editor via Vite's built-in
    // /__open-in-editor endpoint (dev server only).
    document.addEventListener("click", function (event) {
      var target = event.target;
      var link = target && target.closest ? target.closest("[data-editor-file]") : null;
      if (!link) return;
      event.preventDefault();
      fetch("/__open-in-editor?file=" + encodeURIComponent(link.getAttribute("data-editor-file")));
    });
  </script>
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

function renderStackFrames(frames: StackFrame[]): string {
  return frames.map(renderStackFrame).join("\n");
}

function renderStackFrame(frame: StackFrame): string {
  if (!frame.isApp) {
    // Message line vs de-emphasized internal frame.
    return frame.locationText
      ? `<span class="frame-internal">${escapeHtml(frame.raw)}</span>`
      : escapeHtml(frame.raw);
  }

  if (!frame.file || !frame.locationText) return escapeHtml(frame.raw);

  const locationIndex = frame.raw.indexOf(frame.locationText);
  if (locationIndex === -1) return escapeHtml(frame.raw);

  const prefix = frame.raw.slice(0, locationIndex);
  const suffix = frame.raw.slice(locationIndex + frame.locationText.length);
  const link = renderEditorLink(frame.file, frame.line, frame.column, frame.locationText);
  return `${escapeHtml(prefix)}${link}${escapeHtml(suffix)}`;
}

function renderEditorLink(
  file: string,
  line: number | undefined,
  column: number | undefined,
  label: string,
): string {
  let target = file;
  if (line !== undefined) {
    target += `:${line}`;
    if (column !== undefined) target += `:${column}`;
  }

  return `<a class="editor-link" href="#" data-editor-file="${escapeHtml(target)}">${escapeHtml(label)}</a>`;
}

function renderFileValue(file: string, root: string | undefined): string {
  const resolved = resolveEditorFilePath(file, root);
  if (!resolved) return `<span class="value">${escapeHtml(file)}</span>`;

  return `<a class="value editor-link" href="#" data-editor-file="${escapeHtml(resolved)}">${escapeHtml(file)}</a>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
