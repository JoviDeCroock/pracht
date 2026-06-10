import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createISGRegenerationRequest, handlePrachtRequest } from "@pracht/core/server";
import type { NodeAdapterContextArgs, NodeAdapterOptions } from "./node-handler.ts";

export async function regenerateISGPage<TContext>(
  options: NodeAdapterOptions<TContext>,
  pathname: string,
  htmlPath: string,
  contextArgs?: NodeAdapterContextArgs,
): Promise<void> {
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

  if (response.status === 200) {
    const html = await response.text();
    await mkdir(dirname(htmlPath), { recursive: true });
    await writeFile(htmlPath, html, "utf-8");
  }
}

export { createISGRegenerationRequest };
