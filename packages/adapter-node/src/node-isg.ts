import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  createISGRegenerationRequest,
  createRevalidationSingleFlight,
  handlePrachtRequest,
  isCacheableISGResponse,
} from "@pracht/core/server";
import type { NodeAdapterContextArgs, NodeAdapterOptions } from "./node-handler.ts";

// Shared across all handler instances in this process so a stampede of stale
// requests (or repeated webhook posts) for the same output file collapses
// into a single regeneration instead of N parallel renders racing to write.
const regenerationSingleFlight = createRevalidationSingleFlight();

/**
 * Regenerate an ISG page and write it to disk. Returns `true` when fresh
 * HTML was written, `false` when the render did not produce cacheable
 * 200 HTML (the stale on-disk copy is kept in that case).
 */
export async function regenerateISGPage<TContext>(
  options: NodeAdapterOptions<TContext>,
  pathname: string,
  htmlPath: string,
  contextArgs?: NodeAdapterContextArgs,
): Promise<boolean> {
  return regenerationSingleFlight(htmlPath, async () => {
    const request = createISGRegenerationRequest(pathname, contextArgs?.request);
    const context =
      options.createContext && contextArgs
        ? await options.createContext({ ...contextArgs, request })
        : undefined;

    const response = await handlePrachtRequest({
      app: options.app,
      context,
      registry: options.registry,
      request,
      clientEntryUrl: options.clientEntryUrl,
      cssManifest: options.cssManifest,
      jsManifest: options.jsManifest,
    });

    if (response.status !== 200 || !isCacheableISGResponse(response)) {
      return false;
    }

    const html = await response.text();
    await mkdir(dirname(htmlPath), { recursive: true });
    await writeFile(htmlPath, html, "utf-8");
    return true;
  });
}

export { createISGRegenerationRequest };
