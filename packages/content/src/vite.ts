import type { IncomingMessage, ServerResponse } from "node:http";
import { extname } from "node:path";
import type { Connect, Plugin, ViteDevServer } from "vite";

import { artifactFileName } from "./path.ts";
import type { ContentArtifact, ContentCollectionSnapshot } from "./types.ts";

const CONTENT_MODULE_PREFIX = "virtual:pracht/content/";
const RESOLVED_CONTENT_MODULE_PREFIX = `\0${CONTENT_MODULE_PREFIX}`;
export const CONTENT_HEADERS_FILE = "_pracht/content-headers.json";

export interface ViteContentCollection {
  readonly name: string;
  emitArtifacts(): Promise<readonly ContentArtifact[]>;
  invalidate(source?: string): void;
  ownsSource(source: string): boolean;
  renderModule(source: string, raw?: string): Promise<string | undefined>;
  snapshot(): Promise<ContentCollectionSnapshot<Record<string, unknown>, unknown>>;
}

export interface PrachtContentOptions {
  collections: readonly ViteContentCollection[];
}

/**
 * Reuse content collections for Vite module transforms, live development
 * assets, and client build output. The returned transform and asset plugins
 * have separate apply scopes so server route modules remain transformable.
 */
export function prachtContent(options: PrachtContentOptions): Plugin[] {
  const collections = validateCollections(options);

  const transformPlugin: Plugin = {
    name: "pracht:content",
    enforce: "pre",

    resolveId(id) {
      if (!id.startsWith(CONTENT_MODULE_PREFIX)) return null;
      const name = decodeURIComponent(id.slice(CONTENT_MODULE_PREFIX.length));
      return collections.some((collection) => collection.name === name)
        ? `${RESOLVED_CONTENT_MODULE_PREFIX}${encodeURIComponent(name)}`
        : null;
    },

    async load(id) {
      if (!id.startsWith(RESOLVED_CONTENT_MODULE_PREFIX)) return null;
      const name = decodeURIComponent(id.slice(RESOLVED_CONTENT_MODULE_PREFIX.length));
      const collection = collections.find((candidate) => candidate.name === name);
      if (!collection) return null;
      const snapshot = await collection.snapshot();
      const serializedSnapshot = serializeSnapshot(snapshot);
      return [
        `import { defineSnapshotCollection } from "@pracht/content/runtime";`,
        `const snapshot = JSON.parse(${JSON.stringify(serializedSnapshot)});`,
        `export const collection = defineSnapshotCollection(snapshot);`,
        `export default collection;`,
      ].join("\n");
    },

    async transform(code, id) {
      // Preserve Vite's resource-query contracts. By the time transform hooks
      // run, built-ins such as ?raw and ?url have already turned the source
      // into JavaScript; compiling that JavaScript as Markdown would replace
      // the requested representation with a Pracht route module. Internal
      // queries such as ?pracht-client and HMR timestamps still represent the
      // route module itself and must pass through the collection compiler.
      const queryIndex = id.indexOf("?");
      const clean = queryIndex === -1 ? id : id.slice(0, queryIndex);
      if (queryIndex !== -1) {
        const query = new URLSearchParams(id.slice(queryIndex + 1));
        if (query.has("raw") || query.has("url")) return null;
      }
      const transformed: Array<{ code: string; collection: string }> = [];
      for (const collection of collections) {
        if (!collection.ownsSource(clean)) continue;
        const output = await collection.renderModule(clean, code);
        if (output !== undefined) transformed.push({ code: output, collection: collection.name });
      }
      if (transformed.length === 0) return null;
      if (transformed.length > 1) {
        throw new Error(
          `Content source ${JSON.stringify(clean)} is transformed by multiple collections: ${transformed.map((entry) => entry.collection).join(", ")}.`,
        );
      }
      return { code: transformed[0].code, map: null };
    },

    configureServer(server) {
      registerInvalidation(server, collections);
    },
  };

  const artifactPlugin: Plugin = {
    name: "pracht:content-artifacts",
    apply(_config, env) {
      return env.command === "serve" || (env.command === "build" && !env.isSsrBuild);
    },

    configureServer(server) {
      server.middlewares.use(createArtifactMiddleware(collections, server));
    },

    generateBundle: {
      order: "post",
      async handler(_outputOptions, bundle) {
        const artifacts = await collectArtifacts(collections);
        const outputFileNames = Object.keys(bundle);
        const headers: Record<string, Record<string, string>> = {};
        for (const artifact of artifacts) {
          const fileName = artifactFileName(artifact.path);
          const existing = outputFileNames.find((output) => outputPathsCollide(output, fileName));
          if (existing) {
            throw new Error(
              `Content artifact ${JSON.stringify(artifact.path)} collides with existing Vite build output ${JSON.stringify(existing)}. Configure a different artifact path.`,
            );
          }
          this.emitFile({
            type: "asset",
            fileName,
            source: artifact.source,
          });
          outputFileNames.push(fileName);
          headers[artifact.path] = {
            ...(artifact.path.includes("/assets/")
              ? { "cache-control": "public, max-age=0, must-revalidate" }
              : {}),
            "content-type": artifact.contentType ?? inferContentType(artifact.path),
            "x-content-type-options": "nosniff",
          };
        }
        if (artifacts.length > 0) {
          const existing = outputFileNames.find((output) =>
            outputPathsCollide(output, CONTENT_HEADERS_FILE),
          );
          if (existing) {
            throw new Error(
              `Pracht's internal content headers manifest collides with existing Vite build output ${JSON.stringify(existing)}.`,
            );
          }
          this.emitFile({
            type: "asset",
            fileName: CONTENT_HEADERS_FILE,
            source: `${JSON.stringify(headers, null, 2)}\n`,
          });
        }
      },
    },
  };

  return [transformPlugin, artifactPlugin];
}

function serializeSnapshot(
  snapshot: ContentCollectionSnapshot<Record<string, unknown>, unknown>,
): string {
  assertJsonValue(snapshot, "content snapshot", new Set());
  return JSON.stringify(snapshot);
}

function assertJsonValue(value: unknown, path: string, ancestors: Set<object>): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (typeof value !== "object") {
    throw new TypeError(`${path} must be JSON-serializable for a production content module.`);
  }
  if (ancestors.has(value)) {
    throw new TypeError(`${path} must not contain circular values.`);
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonValue(entry, `${path}[${index}]`, ancestors));
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} must contain only plain JSON objects.`);
    }
    for (const [key, entry] of Object.entries(value)) {
      assertJsonValue(entry, `${path}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
}

function validateCollections(options: PrachtContentOptions): readonly ViteContentCollection[] {
  if (!options || typeof options !== "object" || !Array.isArray(options.collections)) {
    throw new TypeError("prachtContent() expects { collections: [...] }.");
  }
  const names = new Set<string>();
  for (const collection of options.collections) {
    if (
      !collection ||
      typeof collection.name !== "string" ||
      typeof collection.snapshot !== "function"
    ) {
      throw new TypeError("prachtContent() collections must come from defineCollection().");
    }
    if (names.has(collection.name)) {
      throw new TypeError(
        `prachtContent() received duplicate collection name ${JSON.stringify(collection.name)}.`,
      );
    }
    names.add(collection.name);
  }
  return Object.freeze([...options.collections]);
}

function registerInvalidation(
  server: ViteDevServer,
  collections: readonly ViteContentCollection[],
): void {
  const invalidate = (file: string) => {
    for (const collection of collections) {
      if (!collection.ownsSource(file)) continue;
      collection.invalidate(file);
      const module = server.moduleGraph.getModuleById(
        `${RESOLVED_CONTENT_MODULE_PREFIX}${encodeURIComponent(collection.name)}`,
      );
      if (module) server.moduleGraph.invalidateModule(module);
    }
  };
  server.watcher.on("add", invalidate);
  server.watcher.on("change", invalidate);
  server.watcher.on("unlink", invalidate);
}

function createArtifactMiddleware(
  collections: readonly ViteContentCollection[],
  server: ViteDevServer,
): Connect.NextHandleFunction {
  let knownArtifactPaths = new Set<string>();
  return async (request: IncomingMessage, response: ServerResponse, next: Connect.NextFunction) => {
    const url = new URL(request.url ?? "/", "http://pracht.local");
    let artifacts: readonly ContentArtifact[];
    try {
      artifacts = await collectArtifacts(collections);
      knownArtifactPaths = new Set(artifacts.map((artifact) => artifact.path));
    } catch (error) {
      if (error instanceof Error) server.ssrFixStacktrace(error);
      server.config.logger.error(
        `[pracht:content] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
      if (!knownArtifactPaths.has(url.pathname)) return next();
      response.statusCode = 500;
      response.setHeader("cache-control", "no-store");
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.end("Content artifact generation failed");
      return;
    }

    const artifact = artifacts.find((candidate) => candidate.path === url.pathname);
    if (!artifact) return next();

    const method = (request.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      response.statusCode = 405;
      response.setHeader("allow", "GET, HEAD");
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.end("Method Not Allowed");
      return;
    }

    response.statusCode = 200;
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-type", artifact.contentType ?? inferContentType(artifact.path));
    response.setHeader("x-content-type-options", "nosniff");
    response.end(method === "HEAD" ? undefined : artifact.source);
  };
}

async function collectArtifacts(
  collections: readonly ViteContentCollection[],
): Promise<readonly ContentArtifact[]> {
  const artifacts: ContentArtifact[] = [];
  const outputs: Array<{ fileName: string; owner: string; path: string }> = [];
  for (const collection of collections) {
    for (const artifact of await collection.emitArtifacts()) {
      const fileName = artifactFileName(artifact.path);
      if (outputPathsCollide(fileName, CONTENT_HEADERS_FILE)) {
        throw new Error(
          `Content artifact ${JSON.stringify(artifact.path)} collides with Pracht's internal content headers manifest. Configure a different artifact path.`,
        );
      }
      if (portableOutputKey(fileName).startsWith("_pracht/")) {
        throw new Error(
          `Content artifact ${JSON.stringify(artifact.path)} uses Pracht's reserved /_pracht build output namespace. Configure a different artifact path.`,
        );
      }

      const existing = outputs.find((output) => outputPathsCollide(output.fileName, fileName));
      if (existing) {
        throw new Error(
          `Content artifact ${JSON.stringify(artifact.path)} from collection ${JSON.stringify(collection.name)} has a portable output-path collision with ${JSON.stringify(existing.path)} from collection ${JSON.stringify(existing.owner)}.`,
        );
      }
      outputs.push({ fileName, owner: collection.name, path: artifact.path });
      artifacts.push(artifact);
    }
  }
  return artifacts;
}

function outputPathsCollide(left: string, right: string): boolean {
  const leftKey = portableOutputKey(left);
  const rightKey = portableOutputKey(right);
  return (
    leftKey === rightKey || leftKey.startsWith(`${rightKey}/`) || rightKey.startsWith(`${leftKey}/`)
  );
}

function portableOutputKey(fileName: string): string {
  return fileName
    .split("/")
    .map((segment) => segment.normalize("NFC").toLowerCase())
    .join("/");
}

function inferContentType(path: string): string {
  switch (extname(path)) {
    case ".json":
      return "application/json; charset=utf-8";
    case ".md":
    case ".markdown":
      return "text/markdown; charset=utf-8";
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".xml":
      return "application/xml; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}
