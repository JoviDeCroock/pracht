import type { ModuleRegistry, PrachtApp, ResolvedApiRoute } from "@pracht/core/server";

export interface VercelExecutionContext {
  waitUntil?(promise: Promise<unknown>): void;
  [key: string]: unknown;
}

export interface VercelContextArgs<
  TVercelContext extends VercelExecutionContext = VercelExecutionContext,
> {
  request: Request;
  context: TVercelContext;
}

export interface VercelAdapterOptions<
  TVercelContext extends VercelExecutionContext = VercelExecutionContext,
  TContext = TVercelContext,
> {
  app: PrachtApp;
  registry?: ModuleRegistry;
  apiRoutes?: ResolvedApiRoute[];
  clientEntryUrl?: string;
  islandsEntryUrl?: string;
  islandsBootstrapRequired?: boolean;
  cssManifest?: Record<string, string[]>;
  jsManifest?: Record<string, string[]>;
  createContext?: (args: VercelContextArgs<TVercelContext>) => TContext | Promise<TContext>;
}

export interface VercelServerEntryModuleOptions {
  functionName?: string;
  regions?: string | string[];
  /** Vite-resolvable module path exporting `createContext(args)`. */
  createContextFrom?: string;
}

/**
 * Structural subset of Node's `IncomingMessage` used by the serverless
 * launcher. Typed inline so this edge-targeted package keeps no dependency on
 * `@types/node`.
 */
export interface VercelNodeRequest {
  headers: Record<string, string | string[] | undefined>;
  method?: string;
  url?: string;
}

/** Structural subset of Node's `ServerResponse` used by the serverless launcher. */
export interface VercelNodeResponse {
  statusCode: number;
  statusMessage?: string;
  setHeader(name: string, value: string | string[]): unknown;
  write(chunk: Uint8Array): unknown;
  end(): unknown;
}
