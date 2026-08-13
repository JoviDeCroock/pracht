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
