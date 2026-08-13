/** Shared contracts for resolved app-graph serialization. */

import type { SpeculationOption } from "./types.ts";

export interface AppGraphRoute {
  file: string;
  hydration: string | null;
  id: string;
  loaderCache: number | false | null;
  loaderFile: string | null;
  /** Present only when middleware-owned Markdown negotiation is declared. */
  markdown?: true;
  middleware: string[];
  path: string;
  prefetch: string | null;
  render: string | null;
  revalidate: unknown;
  shell: string | null;
  shellFile: string | null;
  speculation: SpeculationOption | null;
}

export interface AppGraphApiRoute {
  file: string;
  hasDefaultHandler: boolean;
  methods: string[];
  path: string;
}

export interface AppGraphCapability {
  /**
   * Per-capability Web Bot Auth policy override, or `null` when the capability
   * inherits the app default. Part of the graph because a reviewer cannot
   * otherwise tell whether an exposed capability demands a verified agent.
   */
  agentPolicy: string | null;
  /** Prose contract description — feeds generated JSDoc and agent-facing inspection. */
  description: string | null;
  effect: string | null;
  /**
   * Why this capability's module could not be read, or `null` when it was read
   * successfully. A capability that fails to load (most often because
   * `@pracht/capabilities` is not installed) would otherwise serialize
   * identically to a private capability with no effect class, so every
   * inspection surface would quietly under-report what the app exposes.
   *
   * Optional so existing constructors of this shape stay valid; producers that
   * load modules (`serializeCapabilities`) always set it.
   */
  error?: string | null;
  /**
   * Set when the module could not be executed *and* static analysis could not
   * recover every guard-shaped field (`agentPolicy`, `middleware`). Those are
   * what `pracht plan` warns on, so silently reporting the fallback's blanks
   * would let deleting a capability's auth middleware produce no diff at all.
   */
  unverifiedContract?: true;
  /** Reserved for the MCP Apps projection — always false for now. */
  hasUi: false;
  httpPath: string | null;
  /** Input JSON Schema — feeds `pracht typegen` and agent-facing inspection. */
  input: Record<string, unknown> | null;
  middleware: string[];
  name: string;
  /** Output JSON Schema — feeds `pracht typegen` and agent-facing inspection. */
  output: Record<string, unknown> | null;
  source: string;
  title: string | null;
  /** Exposure transports from the capability's `expose` config. */
  transports: string[];
}

export interface AppGraph {
  api: AppGraphApiRoute[];
  capabilities: AppGraphCapability[];
  /**
   * Path the remote MCP projection is served from, or `null` when the app does
   * not configure `agents.mcp` — in which case `expose.mcp` is recorded in the
   * graph but nothing serves it.
   */
  mcpEndpoint?: string | null;
  routes: AppGraphRoute[];
  /**
   * The app-level not-found page, serialized like a route. `null` when the app
   * declares none. It is reported separately from `routes` because it never
   * participates in matching.
   */
  notFound?: AppGraphRoute | null;
}

export interface AppGraphModuleAccess {
  /** Import an app module by its app-relative file path (e.g. Vite's `ssrLoadModule`). */
  loadModule: (file: string) => Promise<Record<string, unknown>>;
  /** Read an app module's source text — fallback method detection when importing fails. */
  readSource: (file: string) => string;
}

export interface SerializeCapabilitiesOptions {
  /** Fail the graph read when a registered capability module cannot load. */
  strict?: boolean;
}

export interface SerializeApiRoutesOptions {
  /** Fail the graph read instead of inferring exports when an API module cannot load. */
  strict?: boolean;
}

export interface AppGraphStaticModuleAccess {
  /** Read an app module by its app-relative file path. */
  readSource: (file: string) => string;
  /** Resolve a star re-export to another app-relative module. */
  resolveModule?: (specifier: string, importer: string) => string | null | Promise<string | null>;
}
