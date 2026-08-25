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
   * Request phase the failure came from (`loader`, `render`, `middleware`, …),
   * shown as a meta row. A loader failure and a render failure look identical
   * in a stack trace once JSX is compiled away.
   */
  phase?: string;
  /** Loader module path, when the route loads from a separate server file. */
  loaderFile?: string;
  /** Shell module path wrapping the failing route. */
  shellFile?: string;
  /**
   * Project root (Vite's `server.config.root`). Used to resolve
   * dev-server URL paths such as `/src/routes/home.tsx` to filesystem
   * paths for the open-in-editor links.
   */
  root?: string;
  /** Vite deploy base used to reach the dev server's editor endpoint. */
  base?: string;
}

/**
 * SGR/CSI escape sequences, as emitted by every compiler that colours its own
 * diagnostics (oxc, esbuild, Babel). They are meaningless in a browser: a
 * terminal renders `[31m` as "red", HTML renders it as `[31m`, and oxc
 * wraps *every character* of the offending source line in its own sequence, so
 * an uncleaned parse error reads as a wall of `[38;5;249m` noise.
 */
// Built from char codes rather than written as a literal: a `\u001B` escape
// inside a regex literal is a lint error (`no-control-regex`), and suppressing
// the rule would hide the one place it is genuinely intended.
const ESCAPE_INTRODUCERS = `${String.fromCharCode(0x1b)}${String.fromCharCode(0x9b)}`;
const ANSI_ESCAPE = new RegExp(
  `[${ESCAPE_INTRODUCERS}][[\\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PR-TZcf-ntqry=><]`,
  "g",
);

export function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE, "");
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
  const { routeId, file, root } = options;
  // Compiler diagnostics arrive colourized for a terminal. Left in place they
  // render as literal escape sequences around every character of the offending
  // line — the error becomes unreadable exactly when it matters most.
  const message = stripAnsi(options.message);
  const stack = options.stack ? stripAnsi(options.stack) : undefined;
  const openInEditorEndpoint = resolveOpenInEditorEndpoint(options.base);

  const stackHtml = stack
    ? `<pre class="stack">${renderStackFrames(parseStackFrames(stack, { root }))}</pre>`
    : "";

  const phaseHtml = options.phase
    ? `<div class="meta"><span class="label">Phase</span> <span class="value">${escapeHtml(options.phase)}</span></div>`
    : "";

  const routeHtml = routeId
    ? `<div class="meta"><span class="label">Route</span> <span class="value">${escapeHtml(routeId)}</span></div>`
    : "";

  const fileHtml = file
    ? `<div class="meta"><span class="label">File</span> ${renderFileValue(file, root)}</div>`
    : "";

  // A separate loader file only exists when the manifest wires one, and the
  // shell is worth naming because a shell throw surfaces on every route that
  // uses it rather than on the one being requested.
  const loaderHtml =
    options.loaderFile && options.loaderFile !== file
      ? `<div class="meta"><span class="label">Loader</span> ${renderFileValue(options.loaderFile, root)}</div>`
      : "";

  const shellHtml = options.shellFile
    ? `<div class="meta"><span class="label">Shell</span> ${renderFileValue(options.shellFile, root)}</div>`
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
      /* Compiler diagnostics are multi-line source frames; collapsing their
         whitespace turns the caret line into gibberish. */
      white-space: pre-wrap;
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
    ${phaseHtml}
    ${routeHtml}
    ${fileHtml}
    ${loaderHtml}
    ${shellHtml}
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
      fetch(${JSON.stringify(openInEditorEndpoint)} + "?file=" + encodeURIComponent(link.getAttribute("data-editor-file")));
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

function resolveOpenInEditorEndpoint(base: string | undefined): string {
  if (!base || base === "/" || !base.startsWith("/") || base.startsWith("//")) {
    return "/__open-in-editor";
  }
  return `${base.endsWith("/") ? base : `${base}/`}__open-in-editor`;
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
