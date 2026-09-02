/**
 * `@pracht/capabilities/webmcp` — WebMCP page-tool registration.
 *
 * The runtime behind pracht's generated `virtual:pracht/webmcp` shim,
 * published so any site — pracht or not — can register page tools with the
 * same registration semantics and annotation policy. Targets the WebMCP CG
 * draft API: `document.modelContext.registerTool()` (ChatGPT desktop's
 * built-in browser; Chromium 150+ within the origin trial — the `document`
 * getter landed in 150 and the deprecated `navigator.modelContext` alias was
 * removed in 152). No-ops when the API is absent, and a failed registration
 * never breaks the page.
 *
 * `execute()` returns whatever the dispatch resolves to as a plain value: per
 * the spec the host serializes the returned value itself, so wrapping it in
 * MCP-style content blocks would reach the agent double-encoded. Pracht's
 * dispatch resolves to the capability envelope (`{ ok, data }` /
 * `{ ok: false, error }`); a standalone dispatch should do the same.
 */

import type { CapabilityEffect } from "./capability.ts";
import type { JsonSchema } from "./schema.ts";

export interface WebmcpToolAnnotations {
  readOnlyHint?: boolean;
  untrustedContentHint?: boolean;
}

export interface WebmcpTool {
  /** Tool name — for a pracht capability, the registered capability name. */
  name: string;
  /** Optional display title; feeds host UI (e.g. ChatGPT's "Site tools" list). */
  title?: string;
  /** The contract an agent reads. Required — a tool without one is unusable. */
  description: string;
  /** JSON Schema for the tool input. */
  inputSchema: JsonSchema;
  /**
   * Effect class the annotations derive from. `destructive` is rejected: a
   * browser host's approval UX is not a security boundary, so destructive
   * operations must stay behind a server-verified confirmation flow on a
   * server transport.
   */
  effect?: CapabilityEffect;
  /** Marks tool output as untrusted content for the host (prompt-injection hint). */
  untrustedContent?: boolean;
  /** Explicit annotations; merged over the effect-derived ones. */
  annotations?: WebmcpToolAnnotations;
}

export interface WebmcpDispatchOptions {
  signal?: AbortSignal;
}

export interface WebmcpRegistrationOptions {
  /**
   * Own the lifetime of every registration. Aborting removes the tools from
   * the document's model context, matching the current WebMCP draft.
   */
  signal?: AbortSignal;
}

/**
 * Deliver one tool call. Receives the tool name and the input the host
 * collected; resolves to the value the host should serialize back to the
 * agent. Route this at your server-side capability endpoint so validation and
 * policy stay server-side — the page is not a trust boundary.
 */
export type WebmcpDispatch = (
  name: string,
  input: unknown,
  options: WebmcpDispatchOptions,
) => unknown | Promise<unknown>;

/**
 * The annotation set pracht advertises for an effect class. WebMCP currently
 * standardizes only the read-only and untrusted-content hints; remote MCP has
 * additional effect hints and derives those in its own projection.
 */
export function webmcpToolAnnotations(
  effect: CapabilityEffect | undefined,
  untrustedContent?: boolean,
): WebmcpToolAnnotations {
  return {
    readOnlyHint: effect === "read",
    ...(untrustedContent ? { untrustedContentHint: true } : {}),
  };
}

interface ModelContextLike {
  registerTool?: (tool: unknown, options?: WebmcpRegistrationOptions) => unknown;
}

/**
 * Register page tools with the browser's model context. Returns `true` when
 * the WebMCP API is present and registration was attempted, `false` when the
 * browser does not expose it (registration is skipped silently — feature
 * detection is the caller's opt-out).
 *
 * Individual registration failures are swallowed: the API is still an
 * origin-trial surface, and a failed registration must never break the page.
 */
export function registerWebmcpTools(
  tools: readonly WebmcpTool[],
  dispatch: WebmcpDispatch,
  options: WebmcpRegistrationOptions = {},
): boolean {
  const modelContext: ModelContextLike | null =
    (typeof document !== "undefined" &&
      (document as { modelContext?: ModelContextLike }).modelContext) ||
    null;
  if (!modelContext || typeof modelContext.registerTool !== "function") {
    return false;
  }

  for (const tool of tools) {
    if (tool.effect === "destructive") {
      // Same rule the pracht build enforces: destructive operations never
      // become page tools. Skip loudly enough for the author to notice
      // without taking the page down.
      try {
        console.warn(
          `[pracht] WebMCP tool ${JSON.stringify(tool.name)} was not registered: ` +
            "destructive operations cannot be exposed as page tools.",
        );
      } catch {}
      continue;
    }
    try {
      const registration = modelContext.registerTool(
        {
          name: tool.name,
          ...(tool.title ? { title: tool.title } : {}),
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: {
            ...webmcpToolAnnotations(tool.effect, tool.untrustedContent),
            ...tool.annotations,
          },
          async execute(input: unknown, { signal }: { signal?: AbortSignal } = {}) {
            return dispatch(tool.name, input, { signal });
          },
        },
        options,
      );
      if (registration && typeof (registration as { catch?: unknown }).catch === "function") {
        (registration as Promise<unknown>).catch(() => {});
      }
    } catch {
      // The API is still an origin-trial surface; a failed registration
      // must never break the page.
    }
  }
  return true;
}
