/**
 * Self-contained error overlay for pracht dev mode.
 *
 * Returns a standalone HTML document with inline styles and scripts.
 * Not a Preact component — must render even when Preact itself fails.
 *
 * Dev-only: the overlay is served exclusively by the vite-plugin dev SSR
 * middleware, so it can rely on Vite's built-in `/__open-in-editor`
 * endpoint (launch-editor middleware) to make stack frames clickable.
 */

export interface ErrorOverlayOptions {
  message: string;
  stack?: string;
  routeId?: string;
  file?: string;
  /**
   * Project root (Vite's `server.config.root`). Used to resolve
   * dev-server URL paths such as `/src/routes/home.tsx` to filesystem
   * paths for the open-in-editor links.
   */
  root?: string;
}

export interface StackFrame {
  /** The original stack line, unmodified. */
  raw: string;
  /** The exact `file:line:column` substring inside `raw`, when present. */
  locationText?: string;
  /** Normalized filesystem path suitable for `/__open-in-editor`. */
  file?: string;
  line?: number;
  column?: number;
  /** False for node_modules, `node:` internals, and Vite-internal frames. */
  isApp: boolean;
}

const FRAME_PARENS = /^\s*at\s+(?:async\s+)?.*?\((.*)\)\s*$/;
const FRAME_BARE = /^\s*at\s+(?:async\s+)?(.*?)\s*$/;
const LOCATION = /^(.*?):(\d+):(\d+)$/;
const WINDOWS_DRIVE_PATH = /^\/?[A-Za-z]:[\\/]/;

/**
 * Parse a V8-style stack trace into frames. Non-frame lines (the message
 * line, empty lines) are preserved as non-app frames without a location.
 */
export function parseStackFrames(stack: string, options: { root?: string } = {}): StackFrame[] {
  return stack.split("\n").map((line) => parseStackFrameLine(line, options.root));
}

function parseStackFrameLine(raw: string, root: string | undefined): StackFrame {
  const locationText = FRAME_PARENS.exec(raw)?.[1] ?? FRAME_BARE.exec(raw)?.[1];
  if (!locationText) {
    return { raw, isApp: false };
  }

  const location = LOCATION.exec(locationText);
  if (!location) {
    return { raw, locationText, isApp: !isInternalStackPath(locationText) };
  }

  const [, rawPath, line, column] = location;
  if (isInternalStackPath(rawPath)) {
    return { raw, locationText, isApp: false };
  }

  const file = normalizeStackFile(rawPath, root);
  return {
    raw,
    locationText,
    file,
    line: Number(line),
    column: Number(column),
    isApp: true,
  };
}

function isInternalStackPath(path: string): boolean {
  return (
    path === "native" ||
    path === "<anonymous>" ||
    // Nested eval locations like `eval at foo (file:1:2), <anonymous>` are
    // not openable file paths.
    path.includes("(") ||
    path.startsWith("node:") ||
    path.startsWith("internal/") ||
    path.startsWith("virtual:") ||
    path.includes("\0") ||
    path.includes("/node_modules/") ||
    path.includes("\\node_modules\\") ||
    path.includes("/@vite/")
  );
}

/**
 * Normalize a stack-frame path to a filesystem path that Vite's
 * `/__open-in-editor` endpoint can open. Handles `file://` URLs,
 * `http://` dev-server URLs, `/@fs/` prefixes, Vite query suffixes
 * (`?t=123`, `?pracht-client`), and root-relative dev URLs like
 * `/src/routes/home.tsx` (joined onto `root` when provided).
 */
export function normalizeStackFile(rawPath: string, root?: string): string | undefined {
  let path = rawPath;

  if (path.startsWith("http://") || path.startsWith("https://") || path.startsWith("file://")) {
    try {
      const url = new URL(path);
      path = decodeURIComponent(url.pathname);
    } catch {
      return undefined;
    }
  }

  // Strip Vite transform queries and hashes (`/src/a.tsx?t=123`).
  path = path.split("?")[0].split("#")[0];

  if (path.startsWith("/@fs/")) {
    path = path.slice("/@fs".length);
  }

  // `file://C:/...` and `/@fs/C:/...` leave a spurious leading slash on Windows.
  if (WINDOWS_DRIVE_PATH.test(path) && path.startsWith("/")) {
    path = path.slice(1);
  }

  if (!path) return undefined;

  // Root-relative dev-server URL (e.g. `/src/routes/home.tsx`): join onto
  // the project root so launch-editor resolves the real file. Paths already
  // under the root (or Windows drive paths) are absolute filesystem paths.
  if (root && path.startsWith("/") && !WINDOWS_DRIVE_PATH.test(path)) {
    const normalizedRoot = root.endsWith("/") ? root.slice(0, -1) : root;
    if (path !== normalizedRoot && !path.startsWith(`${normalizedRoot}/`)) {
      return `${normalizedRoot}${path}`;
    }
  }

  return path;
}

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

  if (!frame.file || !frame.locationText) {
    return escapeHtml(frame.raw);
  }

  const locationIndex = frame.raw.indexOf(frame.locationText);
  if (locationIndex === -1) {
    return escapeHtml(frame.raw);
  }

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
    if (column !== undefined) {
      target += `:${column}`;
    }
  }

  return `<a class="editor-link" href="#" data-editor-file="${escapeHtml(target)}">${escapeHtml(label)}</a>`;
}

function renderFileValue(file: string, root: string | undefined): string {
  const resolved = resolveEditorFilePath(file, root);
  if (!resolved) {
    return `<span class="value">${escapeHtml(file)}</span>`;
  }

  return `<a class="value editor-link" href="#" data-editor-file="${escapeHtml(resolved)}">${escapeHtml(file)}</a>`;
}

/**
 * Resolve the `file` metadata option (typically a manifest-relative path
 * such as `./routes/home.tsx`) to a filesystem path for open-in-editor.
 */
function resolveEditorFilePath(file: string, root: string | undefined): string | undefined {
  if (file.startsWith("./")) {
    if (!root) return undefined;
    const normalizedRoot = root.endsWith("/") ? root.slice(0, -1) : root;
    // Manifest-relative paths are rooted at the src directory by convention.
    return `${normalizedRoot}/src/${file.slice(2)}`;
  }

  if (file.startsWith("../")) {
    // Cannot resolve reliably without knowing the manifest location.
    return undefined;
  }

  return normalizeStackFile(file, root);
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
