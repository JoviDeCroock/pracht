import { realpathSync } from "node:fs";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { parseFrontmatter } from "./frontmatter.ts";
import {
  artifactFileName,
  isInsideRoot,
  normalizeRelativeSource,
  normalizeRoutePath,
} from "./path.ts";
import type {
  ContentArtifact,
  ContentCollection,
  ContentCollectionSnapshot,
  ContentDocument,
  ContentLocaleOptions,
  ContentLookupOptions,
  ContentResolution,
  ContentSource,
  DefineCollectionOptions,
} from "./types.ts";

interface SourceDescriptor {
  id: string;
  inferredRoute: boolean;
  locale?: string;
  path: string;
  relativePath: string;
  relativeSource: string;
  source: string;
}

interface RegistryIndex {
  descriptors: readonly SourceDescriptor[];
  byId: Map<string, Map<string, SourceDescriptor>>;
  byRoute: Map<string, Map<string, SourceDescriptor>>;
  bySource: Map<string, SourceDescriptor>;
  routeAliases: Map<string, { id: string; locale: string }>;
}

interface CachedDocument<TFrontmatter extends Record<string, unknown>, TCompiled> {
  fingerprint: string;
  promise: Promise<ContentDocument<TFrontmatter, TCompiled>>;
  raw?: string;
}

const NO_LOCALE = "\0";

export function defineCollection<
  TFrontmatter extends Record<string, unknown> = Record<string, unknown>,
  TCompiled = string,
>(
  options: DefineCollectionOptions<TFrontmatter, TCompiled>,
): ContentCollection<TFrontmatter, TCompiled> {
  assertOptions(options);

  const root = normalizeRoot(options.root);
  const canonicalRoot = canonicalFilePath(root);
  const extensions = Object.freeze(
    [...new Set(options.extensions ?? [".md", ".mdx"])].map((extension) =>
      extension.startsWith(".") ? extension : `.${extension}`,
    ),
  );
  const routeBase = normalizeRoutePath(options.routeBase ?? "/", "content routeBase");
  const locales = normalizeLocales(options.locales);
  let realRoot: string | undefined;
  const explicitSources = options.sources
    ? Object.freeze(options.sources.map((source) => ({ ...source })))
    : undefined;
  const cache = new Map<string, CachedDocument<TFrontmatter, TCompiled>>();
  let registryCache: Promise<RegistryIndex> | undefined;
  let artifactCache: Promise<readonly ContentArtifact[]> | undefined;

  const collection: ContentCollection<TFrontmatter, TCompiled> = {
    name: options.name,
    root,
    extensions,
    locales,

    async all() {
      const registry = await buildRegistry();
      return Promise.all(registry.descriptors.map((descriptor) => loadDescriptor(descriptor)));
    },

    async *iterate() {
      const registry = await buildRegistry();
      for (const descriptor of registry.descriptors) yield await loadDescriptor(descriptor);
    },

    async getById(id, lookupOptions) {
      return (await resolveLookup("id", id, lookupOptions))?.document;
    },

    async getByRoute(path, lookupOptions) {
      return (await resolveLookup("route", normalizeRoutePath(path), lookupOptions))?.document;
    },

    async resolveById(id, lookupOptions) {
      return resolveLookup("id", id, lookupOptions);
    },

    async resolveByRoute(path, lookupOptions) {
      return resolveLookup("route", normalizeRoutePath(path), lookupOptions);
    },

    async getBySource(source) {
      const clean = resolveCollectionSource(source);
      if (!collection.ownsSource(clean)) return undefined;
      const registry = await buildRegistry();
      const descriptor = findSourceDescriptor(registry, clean);
      return descriptor ? loadDescriptor(descriptor) : undefined;
    },

    ownsSource(source) {
      const clean = resolveCollectionSource(source);
      return collectionSourceIdentity(clean) !== undefined && extensions.includes(extname(clean));
    },

    async loadSource(source, raw) {
      const clean = resolveCollectionSource(source);
      if (!collection.ownsSource(clean)) {
        throw new Error(
          `Source ${JSON.stringify(source)} does not belong to content collection ${JSON.stringify(options.name)}.`,
        );
      }
      const registry = await buildRegistry();
      const descriptor = findSourceDescriptor(registry, clean);
      if (!descriptor) {
        throw new Error(
          `Source ${JSON.stringify(source)} is not registered in content collection ${JSON.stringify(options.name)}.`,
        );
      }
      return loadDescriptor(descriptor, raw);
    },

    async renderModule(source, raw) {
      if (!options.module) return undefined;
      const clean = resolveCollectionSource(source);
      if (!collection.ownsSource(clean)) return undefined;
      const registry = await buildRegistry();
      const descriptor = findSourceDescriptor(registry, clean);
      if (!descriptor) return undefined;
      return options.module(await loadDescriptor(descriptor, raw));
    },

    async emitArtifacts() {
      if (!options.artifacts?.length) return [];
      if (artifactCache) return artifactCache;
      const pending = (async () => {
        const documents = await collection.all();
        const artifacts: ContentArtifact[] = [];
        const seen = new Set<string>();

        for (const generate of options.artifacts ?? []) {
          const generated = await generate({ collection, documents });
          for (const artifact of generated == null
            ? []
            : Array.isArray(generated)
              ? generated
              : [generated]) {
            artifactFileName(artifact.path);
            const path = normalizeRoutePath(artifact.path, "content artifact path");
            if (seen.has(path)) {
              throw new Error(
                `Content collection ${JSON.stringify(options.name)} emitted duplicate artifact ${JSON.stringify(path)}.`,
              );
            }
            seen.add(path);
            if (typeof artifact.source !== "string" && !(artifact.source instanceof Uint8Array)) {
              throw new TypeError(
                `Content artifact ${JSON.stringify(path)} has an invalid source.`,
              );
            }
            artifacts.push(Object.freeze({ ...artifact, path }));
          }
        }

        return Object.freeze(artifacts);
      })();
      artifactCache = pending;
      try {
        return await pending;
      } catch (error) {
        if (artifactCache === pending) artifactCache = undefined;
        throw error;
      }
    },

    async snapshot(): Promise<ContentCollectionSnapshot<TFrontmatter, TCompiled>> {
      const registry = await buildRegistry();
      const documents = await Promise.all(
        registry.descriptors.map(async (descriptor) => {
          const { locale, source: _source, ...document } = await loadDescriptor(descriptor);
          return locale === undefined ? document : { ...document, locale };
        }),
      );
      return {
        name: options.name,
        extensions: [...extensions],
        ...(locales
          ? {
              locales: {
                ...locales,
                ...(locales.fallback === undefined
                  ? {}
                  : { fallback: cloneFallback(locales.fallback) }),
                supported: [...locales.supported],
              },
            }
          : {}),
        documents,
        routeAliases: [...registry.routeAliases].map(([path, alias]) => ({ ...alias, path })),
      };
    },

    invalidate(source) {
      artifactCache = undefined;
      registryCache = undefined;
      if (source === undefined) {
        cache.clear();
        return;
      }
      const clean = resolveCollectionSource(source);
      const identity = collectionSourceIdentity(clean);
      for (const cachedSource of cache.keys()) {
        if (
          cachedSource === clean ||
          (identity !== undefined && collectionSourceIdentity(cachedSource) === identity)
        ) {
          cache.delete(cachedSource);
        }
      }
    },
  };

  async function buildRegistry(): Promise<RegistryIndex> {
    if (registryCache) return registryCache;
    const pending = createRegistry();
    registryCache = pending;
    try {
      return await pending;
    } catch (error) {
      if (registryCache === pending) registryCache = undefined;
      throw error;
    }
  }

  async function createRegistry(): Promise<RegistryIndex> {
    const sources = explicitSources ?? (await scanSources(root, extensions));
    const descriptors = sources
      .map((source) => createDescriptor(source))
      .filter((descriptor): descriptor is SourceDescriptor => descriptor !== undefined)
      .sort((left, right) =>
        left.path === right.path
          ? compare(left.locale ?? "", right.locale ?? "")
          : compare(left.path, right.path),
      );

    const byId = new Map<string, Map<string, SourceDescriptor>>();
    const byRoute = new Map<string, Map<string, SourceDescriptor>>();
    const bySource = new Map<string, SourceDescriptor>();
    const routeAliases = new Map<string, { id: string; locale: string }>();
    for (const descriptor of descriptors) {
      addLookup(byId, descriptor.id, descriptor);
      addLookup(byRoute, descriptor.path, descriptor);
      const sourceKeys = new Set([descriptor.source, canonicalFilePath(descriptor.source)]);
      if ([...sourceKeys].some((source) => bySource.has(source))) {
        throw new Error(
          `Content collection ${JSON.stringify(options.name)} registers source ${JSON.stringify(descriptor.relativeSource)} more than once.`,
        );
      }
      for (const source of sourceKeys) bySource.set(source, descriptor);
      if (locales && descriptor.inferredRoute) {
        for (const locale of locales.supported) {
          const configured = options.route?.({
            id: descriptor.id,
            locale,
            relativePath: descriptor.relativePath,
          });
          if (configured === false) continue;
          const alias = normalizeRoutePath(
            configured ??
              createGeneratedRoute({
                id: descriptor.id,
                locale,
                relativePath: descriptor.relativePath,
              }),
          );
          const existing = routeAliases.get(alias);
          if (existing && existing.id !== descriptor.id) {
            throw new Error(
              `Content collection ${JSON.stringify(options.name)} has ambiguous generated route alias ${JSON.stringify(alias)}.`,
            );
          }
          if (!existing) routeAliases.set(alias, { id: descriptor.id, locale });
        }
      }
    }
    return { byId, byRoute, bySource, descriptors, routeAliases };
  }

  function createDescriptor(sourceInput: ContentSource): SourceDescriptor | undefined {
    const relativeSource = normalizeRelativeSource(root, sourceInput.source);
    const extension = extname(relativeSource);
    if (!extensions.includes(extension)) {
      if (explicitSources) {
        throw new TypeError(
          `Content source ${JSON.stringify(relativeSource)} does not match the collection extensions.`,
        );
      }
      return undefined;
    }

    let relativePath = relativeSource.slice(0, -extension.length);
    let locale = sourceInput.locale;
    if (locales) {
      if (!locale && locales.sourceDirectories) {
        const [candidate, ...rest] = relativePath.split("/");
        if (rest.length > 0 && locales.supported.includes(candidate)) {
          locale = candidate;
          relativePath = rest.join("/");
        }
      }
      locale ??= locales.default;
      assertSupportedLocale(locale, locales, `source ${JSON.stringify(relativeSource)}`);
    } else if (locale) {
      throw new TypeError(
        `Content source ${JSON.stringify(relativeSource)} declares locale ${JSON.stringify(locale)} without collection locales.`,
      );
    }

    const generatedId = routeId(relativePath);
    const id = sourceInput.id ?? generatedId;
    if (!id || id.includes("\0")) {
      throw new TypeError(`Content source ${JSON.stringify(relativeSource)} has an invalid id.`);
    }
    const generatedPath = createGeneratedRoute({ id, locale, relativePath });
    const configuredPath = sourceInput.path ?? options.route?.({ id, locale, relativePath });
    if (configuredPath === false) return undefined;
    const path = normalizeRoutePath(configuredPath ?? generatedPath);

    return {
      id,
      inferredRoute: sourceInput.path === undefined,
      locale,
      path,
      relativePath,
      relativeSource,
      source: resolve(root, relativeSource),
    };
  }

  function createGeneratedRoute(context: {
    id: string;
    locale?: string;
    relativePath: string;
  }): string {
    const prefix = localeRoutePrefix(context.locale, locales);
    const base = routeBase === "/" ? "" : routeBase;
    const suffix = context.id === "index" ? "" : `/${context.id}`;
    return `${prefix}${base}${suffix}` || "/";
  }

  function addLookup(
    lookup: Map<string, Map<string, SourceDescriptor>>,
    key: string,
    descriptor: SourceDescriptor,
  ): void {
    const localized = lookup.get(key) ?? new Map<string, SourceDescriptor>();
    const localeKey = descriptor.locale ?? NO_LOCALE;
    const existing = localized.get(localeKey);
    if (existing) {
      throw new Error(
        `Content collection ${JSON.stringify(options.name)} maps both ${JSON.stringify(existing.relativeSource)} and ${JSON.stringify(descriptor.relativeSource)} to ${JSON.stringify(key)}${descriptor.locale ? ` for locale ${JSON.stringify(descriptor.locale)}` : ""}.`,
      );
    }
    localized.set(localeKey, descriptor);
    lookup.set(key, localized);
  }

  async function resolveLookup(
    kind: "id" | "route",
    key: string,
    lookupOptions: ContentLookupOptions = {},
  ): Promise<ContentResolution<TFrontmatter, TCompiled> | undefined> {
    const registry = await buildRegistry();
    const alias = kind === "route" ? registry.routeAliases.get(key) : undefined;
    const localized =
      kind === "id"
        ? registry.byId.get(key)
        : (registry.byRoute.get(key) ?? (alias ? registry.byId.get(alias.id) : undefined));
    if (!localized) return undefined;

    const requestedLocale = resolveRequestedLocale(
      lookupOptions.locale ?? alias?.locale,
      locales,
      localized,
      kind === "route",
    );
    const localeOrder = resolveLocaleOrder(
      requestedLocale,
      lookupOptions.fallback !== false,
      locales,
    );
    for (const locale of localeOrder) {
      const descriptor = localized.get(locale ?? NO_LOCALE);
      if (!descriptor) continue;
      return {
        document: await loadDescriptor(descriptor),
        fallback: locale !== requestedLocale,
        requestedLocale,
      };
    }
    return undefined;
  }

  async function loadDescriptor(
    descriptor: SourceDescriptor,
    rawOverride?: string,
  ): Promise<ContentDocument<TFrontmatter, TCompiled>> {
    const [resolvedRoot, resolvedSource] = await Promise.all([
      resolveRealRoot(),
      realpath(descriptor.source),
    ]);
    if (!isInsideRoot(resolvedRoot, resolvedSource)) {
      throw new TypeError(
        `Content source ${JSON.stringify(descriptor.relativeSource)} must stay inside the collection root after resolving symbolic links.`,
      );
    }

    let fingerprint: string;
    let raw: string | undefined = rawOverride;
    if (rawOverride !== undefined) {
      fingerprint = `raw:${rawOverride.length}`;
      const cached = cache.get(descriptor.source);
      if (cached?.fingerprint === fingerprint && cached.raw === rawOverride) return cached.promise;
    } else {
      const sourceStat = await stat(descriptor.source);
      fingerprint = `fs:${sourceStat.mtimeMs}:${sourceStat.size}`;
      const cached = cache.get(descriptor.source);
      if (cached?.fingerprint === fingerprint) return cached.promise;
      raw = await readFile(descriptor.source, "utf8");
    }

    if (raw === undefined) {
      throw new Error(
        `Content source ${JSON.stringify(descriptor.relativeSource)} could not be read.`,
      );
    }
    const sourceText = raw;
    const promise = (async () => {
      const parsed = options.parse
        ? await options.parse(sourceText, descriptor.source)
        : parseFrontmatter<TFrontmatter>(sourceText);
      if (!parsed || typeof parsed.body !== "string" || !isRecord(parsed.frontmatter)) {
        throw new TypeError(
          `Content parser for ${JSON.stringify(descriptor.relativeSource)} must return { body, frontmatter }.`,
        );
      }
      const input = {
        body: parsed.body,
        frontmatter: Object.freeze({ ...parsed.frontmatter }) as TFrontmatter,
        id: descriptor.id,
        locale: descriptor.locale,
        path: descriptor.path,
        raw: sourceText,
        relativeSource: descriptor.relativeSource,
        source: descriptor.source,
      };
      const compiled = options.compile
        ? await options.compile(input)
        : (input.body as unknown as TCompiled);
      return Object.freeze({ ...input, compiled });
    })();

    cache.set(descriptor.source, { fingerprint, promise, raw: rawOverride });
    try {
      return await promise;
    } catch (error) {
      if (cache.get(descriptor.source)?.promise === promise) cache.delete(descriptor.source);
      throw error;
    }
  }

  function resolveCollectionSource(source: string): string {
    const clean = source.split("?")[0];
    return isAbsolute(clean) ? resolve(clean) : resolve(root, clean);
  }

  function findSourceDescriptor(
    registry: RegistryIndex,
    source: string,
  ): SourceDescriptor | undefined {
    return registry.bySource.get(source) ?? registry.bySource.get(canonicalFilePath(source));
  }

  function collectionSourceIdentity(source: string): string | undefined {
    const canonical = tryCanonicalFilePath(source);
    if (canonical !== undefined) {
      return relativeInsideRoot(canonicalRoot, canonical);
    }

    // Vite's watcher reports unlink events through the configured symlink
    // path. Once the target is gone it cannot be canonicalized, so retain a
    // stable collection-relative identity through either spelling of the root.
    return relativeInsideRoot(root, source) ?? relativeInsideRoot(canonicalRoot, source);
  }

  async function resolveRealRoot(): Promise<string> {
    return realRoot ?? (realRoot = await realpath(root));
  }

  return Object.freeze(collection);
}

function canonicalFilePath(path: string): string {
  return tryCanonicalFilePath(path) ?? resolve(path);
}

function tryCanonicalFilePath(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
}

function relativeInsideRoot(root: string, source: string): string | undefined {
  if (!isInsideRoot(root, source)) return undefined;
  return relative(root, resolve(source)).split(sep).join("/");
}

function cloneFallback(
  fallback: ContentLocaleOptions["fallback"],
): ContentLocaleOptions["fallback"] {
  if (Array.isArray(fallback)) return [...fallback];
  if (!fallback || typeof fallback === "string") return fallback;
  return Object.fromEntries(
    Object.entries(fallback).map(([locale, value]) => [
      locale,
      Array.isArray(value) ? [...value] : value,
    ]),
  );
}

function assertOptions<TFrontmatter extends Record<string, unknown>, TCompiled>(
  options: DefineCollectionOptions<TFrontmatter, TCompiled>,
): void {
  if (!options || typeof options !== "object") {
    throw new TypeError("defineCollection() expects an options object.");
  }
  if (typeof options.name !== "string" || !options.name.trim()) {
    throw new TypeError("defineCollection() name must be a non-empty string.");
  }
  if (!(typeof options.root === "string" || options.root instanceof URL)) {
    throw new TypeError("defineCollection() root must be an absolute path or file URL.");
  }
  if (options.sources && !Array.isArray(options.sources)) {
    throw new TypeError("defineCollection() sources must be an array.");
  }
}

function normalizeRoot(root: string | URL): string {
  const path = root instanceof URL ? fileURLToPath(root) : root;
  if (!isAbsolute(path)) {
    throw new TypeError("defineCollection() root must be absolute.");
  }
  return resolve(path);
}

function normalizeLocales(
  locales: ContentLocaleOptions | undefined,
):
  | (ContentLocaleOptions & { supported: readonly string[]; sourceDirectories: boolean })
  | undefined {
  if (!locales) return undefined;
  if (typeof locales.default !== "string" || !locales.default) {
    throw new TypeError("Content locales.default must be a non-empty string.");
  }
  const supported = [...new Set(locales.supported)];
  if (!supported.includes(locales.default)) {
    throw new TypeError("Content locales.supported must include locales.default.");
  }
  for (const locale of supported) {
    if (!locale || locale.includes("/") || locale.includes("\0")) {
      throw new TypeError(`Invalid content locale ${JSON.stringify(locale)}.`);
    }
  }
  return Object.freeze({
    ...locales,
    sourceDirectories: locales.sourceDirectories ?? true,
    supported: Object.freeze(supported),
  });
}

async function scanSources(root: string, extensions: readonly string[]): Promise<ContentSource[]> {
  const sources: ContentSource[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compare(left.name, right.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile() && extensions.includes(extname(entry.name))) {
        sources.push({ source: normalizeRelativeSource(root, absolute) });
      }
    }
  }
  await visit(root);
  return sources;
}

function routeId(relativePath: string): string {
  const normalized = relativePath.replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized === "index") return "index";
  return normalized.endsWith("/index") ? normalized.slice(0, -"/index".length) : normalized;
}

function localeRoutePrefix(
  locale: string | undefined,
  locales:
    | (ContentLocaleOptions & { supported: readonly string[]; sourceDirectories: boolean })
    | undefined,
): string {
  if (!locale || !locales || locales.routePrefix === "never") return "";
  const strategy = locales.routePrefix ?? "non-default";
  return strategy === "always" || locale !== locales.default ? `/${locale}` : "";
}

function resolveRequestedLocale(
  requested: string | undefined,
  locales:
    | (ContentLocaleOptions & { supported: readonly string[]; sourceDirectories: boolean })
    | undefined,
  candidates: Map<string, SourceDescriptor>,
  inferFromRoute: boolean,
): string | undefined {
  if (!locales) return undefined;
  const locale = requested ?? locales.default;
  assertSupportedLocale(locale, locales, "lookup");
  if (
    inferFromRoute &&
    requested === undefined &&
    !candidates.has(locale) &&
    candidates.size === 1
  ) {
    return [...candidates.values()][0].locale;
  }
  return locale;
}

function resolveLocaleOrder(
  requested: string | undefined,
  allowFallback: boolean,
  locales:
    | (ContentLocaleOptions & { supported: readonly string[]; sourceDirectories: boolean })
    | undefined,
): Array<string | undefined> {
  if (!locales || !requested) return [undefined];
  if (!allowFallback) return [requested];

  const configured = locales.fallback;
  let fallbacks: readonly string[];
  if (typeof configured === "string") {
    fallbacks = requested === locales.default ? [] : [configured];
  } else if (Array.isArray(configured)) {
    fallbacks = requested === locales.default ? [] : configured;
  } else if (configured) {
    const record = configured as Readonly<Record<string, string | readonly string[]>>;
    const value = Object.hasOwn(record, requested) ? record[requested] : undefined;
    fallbacks = typeof value === "string" ? [value] : (value ?? []);
  } else {
    fallbacks = requested === locales.default ? [] : [locales.default];
  }

  const order = [requested];
  for (const locale of fallbacks) {
    assertSupportedLocale(locale, locales, `fallback for ${JSON.stringify(requested)}`);
    if (!order.includes(locale)) order.push(locale);
  }
  return order;
}

function assertSupportedLocale(locale: string, locales: ContentLocaleOptions, label: string): void {
  if (!locales.supported.includes(locale)) {
    throw new TypeError(`${label} uses unsupported content locale ${JSON.stringify(locale)}.`);
  }
}

function compare(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
