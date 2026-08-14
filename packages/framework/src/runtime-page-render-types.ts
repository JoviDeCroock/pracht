import type {
  HeadMetadata,
  ResolvedPrachtApp,
  RouteMatch,
  RouteModule,
  ShellModule,
} from "./types.ts";

export interface RenderPageRepresentationOptions {
  clientEntryUrl?: string;
  cssManifest?: Record<string, string[]>;
  data: unknown;
  documentHeaders: Headers;
  hasLoader: boolean;
  head: HeadMetadata;
  islandsBootstrapRequired?: boolean;
  islandsEntryUrl?: string;
  jsManifest?: Record<string, string[]>;
  match: RouteMatch;
  request: Request;
  requestPath: string;
  resolvedApp: ResolvedPrachtApp;
  routeModule: RouteModule;
  shellModule: ShellModule | undefined;
  status: number;
}
