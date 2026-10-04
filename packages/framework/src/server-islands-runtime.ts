import type {
  createServerIslandRenderState,
  declaredServerIslands,
  getServerIslandsClientEntryUrl,
  handleServerIslandRequest,
  resolveInlineServerIslands,
  ServerIslandRenderContext,
} from "./server-islands-server.ts";

/**
 * What the page runtime and the request handler call into for server islands.
 * `server-islands-server.ts` installs it when the generated server module
 * registers at least one server island, so an app without a server islands
 * directory never imports that module and its server bundle carries none of it.
 */
export interface ServerIslandsRuntime {
  createRenderState: typeof createServerIslandRenderState;
  declared: typeof declaredServerIslands;
  getClientEntryUrl: typeof getServerIslandsClientEntryUrl;
  handleRequest: typeof handleServerIslandRequest;
  RenderContext: typeof ServerIslandRenderContext;
  resolveInline: typeof resolveInlineServerIslands;
}

let installed: ServerIslandsRuntime | undefined;

export function installServerIslandsRuntime(runtime: ServerIslandsRuntime | undefined): void {
  installed = runtime;
}

/** The installed server islands runtime, or `undefined` in an app without server islands. */
export function getServerIslandsRuntime(): ServerIslandsRuntime | undefined {
  return installed;
}
