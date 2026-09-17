import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import type { Dirent } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Plugin, Rollup } from "vite";

import { resolveClientOutDir } from "./plugin-assets.ts";

/**
 * Stylesheets and assets for routes that are not in the client bundle.
 *
 * `hydration: "none"` ships no JavaScript and `hydration: "islands"` pulls in
 * the islands rather than the route module, so neither route reaches the client
 * build — and the CSS manifest is built from that build. Their CSS modules were
 * compiled for their class names during SSR and then emitted nowhere: the page
 * shipped hashed class names with no rules behind them, no warning, no file.
 *
 * Those stylesheets are static, so nothing about them needs the client graph.
 * `ssrEmitAssets` makes the server build write them out, its chunk graph says
 * which route each one belongs to, and they are copied into the client output
 * to be served like any other asset.
 *
 * The same holds for everything else such a route imports through Vite's asset
 * pipeline — an `<img src>` built from `import dots from "./dots.svg"`, the
 * source behind a `?pracht` image import. The page renders a URL under `base`
 * for a file that was only ever written to `dist/server`, so those travel out
 * of the server build too.
 *
 * The mapping is only known once Rollup has named the assets, which is after
 * the generated server module was written. It is spliced into a token in that
 * module here, the way Vite resolves its own `__VITE_ASSET__` references.
 */
export const ROUTE_CSS_MANIFEST_TOKEN = "__PRACHT_ROUTE_CSS_MANIFEST__";
export const ROUTE_CSS_CONTENT_TOKEN = "__PRACHT_ROUTE_CSS_CONTENT__";

/**
 * Escape JSON for embedding inside a JavaScript string literal, whichever quote
 * the bundler settles on. `JSON.stringify` covers double quotes and control
 * characters; single quotes are escaped too so the result is valid in either.
 */
export function escapeForStringLiteral(json: string): string {
  return JSON.stringify(json).slice(1, -1).replace(/'/g, "\\'");
}

/**
 * Walk a chunk's imports for the CSS they pull in. Vite records a chunk's own
 * stylesheets on `viteMetadata.importedCss` and leaves the rest to its imports,
 * so a route that renders a styled component only reaches that component's
 * stylesheet transitively.
 */
function collectChunkCss(
  bundle: Rollup.OutputBundle,
  fileName: string,
  seen = new Set<string>(),
  isRoot = true,
): string[] {
  if (seen.has(fileName)) return [];
  seen.add(fileName);
  const output = bundle[fileName];
  if (!output || output.type !== "chunk") return [];
  const chunk = output as Rollup.OutputChunk & { viteMetadata?: { importedCss?: Set<string> } };
  // The server entry holds every island and every other route, so walking into
  // it would hand each route the whole app's CSS. A route reaches it only
  // because an island it renders was hoisted there; that island's stylesheets
  // are resolved from the island's own manifest entry.
  if (!isRoot && chunk.isEntry) return [];
  const css = [...(chunk.viteMetadata?.importedCss ?? [])];
  for (const imported of chunk.imports ?? []) {
    css.push(...collectChunkCss(bundle, imported, seen, false));
  }
  return css;
}

/**
 * Walk a chunk's imports for the files it renders a URL to — an `<img src>`
 * from `import dots from "./dots.svg"`, the source an `?pracht` image import
 * hands `<Image>`.
 *
 * Vite records these on `viteMetadata.importedAssets`, the way it records
 * stylesheets, and an asset import becomes its own small chunk in the server
 * build, so a route reaches its own assets the same way it reaches a
 * component's CSS: through its imports. The entry is skipped for the same
 * reason the CSS walk skips it — it holds every route and every API handler,
 * and publishing what only an API route reads would put a server-side file on
 * the CDN.
 */
function collectChunkAssets(
  bundle: Rollup.OutputBundle,
  fileName: string,
  seen = new Set<string>(),
  isRoot = true,
): string[] {
  if (seen.has(fileName)) return [];
  seen.add(fileName);
  const output = bundle[fileName];
  if (!output || output.type !== "chunk") return [];
  const chunk = output as Rollup.OutputChunk & { viteMetadata?: { importedAssets?: Set<string> } };
  if (!isRoot && chunk.isEntry) return [];
  const assets = [...(chunk.viteMetadata?.importedAssets ?? [])];
  for (const imported of chunk.imports ?? []) {
    assets.push(...collectChunkAssets(bundle, imported, seen, false));
  }
  return assets;
}

/**
 * Every `url()` target and `@import` in a stylesheet, as written.
 *
 * Quoted and bare forms both appear in Vite's output depending on the value, so
 * all three are matched and the first group that participated is the target.
 */
function* referencedUrls(css: string): Generator<string> {
  const pattern =
    /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)|@import\s+(?:"([^"]*)"|'([^']*)')/g;
  for (const match of css.matchAll(pattern)) {
    const url = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5];
    if (url) yield url;
  }
}

/**
 * The bundle key a stylesheet's reference points at, or undefined when it
 * points somewhere the build does not own (a data URI, another origin, a bare
 * fragment).
 *
 * Vite writes these as `base` + the emitted file name, so stripping `base`
 * yields the key — including for a CDN base, where the URL is absolute and
 * still starts with it. A root-relative URL under a non-root base belongs to
 * something else and is left alone; a relative one resolves against the
 * stylesheet's own directory.
 */
function resolveBundleFileName(url: string, base: string, fromFile: string): string | undefined {
  const target = url.split("?")[0]!.split("#")[0]!;
  if (!target || target.startsWith("data:") || target.startsWith("#")) return undefined;

  if (base !== "/" && target.startsWith(base)) return target.slice(base.length);
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) return undefined;
  if (target.startsWith("/")) return base === "/" ? target.slice(1) : undefined;

  // Relative to the stylesheet: "../fonts/inter.woff2" from "assets/app.css".
  const segments = dirname(fromFile)
    .split("/")
    .filter((segment) => segment !== ".");
  for (const segment of target.split("/")) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments.filter(Boolean).join("/");
}

/**
 * The assets a route's stylesheets reference — background images, self-hosted
 * fonts, `@import`ed stylesheets.
 *
 * These are emitted next to the stylesheet in the server build, and until they
 * are copied out with it the deployed page asks for a file that only ever
 * existed in `dist/server`. Only assets the bundle actually holds are
 * returned, so a URL pointing at `public/` or another origin is left alone.
 */
export function collectReferencedAssets(
  bundle: Rollup.OutputBundle,
  cssFiles: Iterable<string>,
  base: string,
): string[] {
  const seen = new Set<string>(cssFiles);
  const pending = [...seen];
  const referenced: string[] = [];

  while (pending.length > 0) {
    const file = pending.pop()!;
    const output = bundle[file];
    if (!output || output.type !== "asset") continue;
    const source = (output as Rollup.OutputAsset).source;
    const css = typeof source === "string" ? source : Buffer.from(source).toString("utf-8");

    for (const url of referencedUrls(css)) {
      const name = resolveBundleFileName(url, base, file);
      if (!name || seen.has(name) || !bundle[name]) continue;
      seen.add(name);
      referenced.push(name);
      // An `@import`ed stylesheet can reference assets of its own.
      if (name.endsWith(".css")) pending.push(name);
    }
  }

  return referenced;
}

const STYLESHEET_RE = /\.(?:css|scss|sass|less|styl|stylus|pcss|postcss|sss)(?:\?|$)/;
const STYLESHEET_QUERY_RE = /[?&](?:inline|raw|url)(?:[=&]|$)/;

function isStylesheetModule(id: string): boolean {
  return STYLESHEET_RE.test(id) && !STYLESHEET_QUERY_RE.test(id);
}

/** Which chunk absorbed each module, so a stylesheet can be traced to its asset. */
function mapModulesToChunks(bundle: Rollup.OutputBundle): Map<string, Rollup.OutputChunk> {
  const owners = new Map<string, Rollup.OutputChunk>();
  for (const output of Object.values(bundle)) {
    if (output.type !== "chunk") continue;
    const chunk = output as Rollup.OutputChunk;
    for (const moduleId of Object.keys(chunk.modules ?? {})) owners.set(moduleId, chunk);
  }
  return owners;
}

function chunkCssFiles(chunk: Rollup.OutputChunk): string[] {
  return [
    ...((chunk as { viteMetadata?: { importedCss?: Set<string> } }).viteMetadata?.importedCss ??
      []),
  ];
}

/**
 * Stylesheets a route imports that the chunk walk cannot reach.
 *
 * The walk stops at entry chunks because the server entry holds the whole app,
 * so anything the bundler hoisted in there — a component an island and a route
 * both use, a stylesheet imported by middleware — used to fall out of the
 * route's CSS entirely. The module graph still knows what the route imports, so
 * ask it: every stylesheet reachable from the route's own module, resolved to
 * the chunk that carries it.
 *
 * Linking a merged entry stylesheet gives a route more CSS than it uses, which
 * is why islands are split into their own chunks before this runs. What is left
 * here is a genuine hoist, reported once so it can be fixed at the source.
 */
function collectHoistedCss(
  context: { getModuleInfo(id: string): { importedIds?: readonly string[] } | null },
  entryModuleId: string,
  owners: Map<string, Rollup.OutputChunk>,
  collected: ReadonlySet<string>,
): { files: string[]; hoistedFrom: string[] } {
  const files: string[] = [];
  const hoistedFrom: string[] = [];
  const seen = new Set<string>();
  const pending = [entryModuleId];

  while (pending.length > 0) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);

    if (isStylesheetModule(id)) {
      const owner = owners.get(id);
      if (owner) {
        for (const file of chunkCssFiles(owner)) {
          if (collected.has(file) || files.includes(file)) continue;
          files.push(file);
          if (owner.isEntry) hoistedFrom.push(id);
        }
      }
      continue;
    }

    // Dependencies are followed one level — an app module importing a
    // package's stylesheet is common; a package's internal graph is not the
    // app's to reorganize, and walking it would cost far more than it finds.
    if (id.includes("node_modules")) continue;
    for (const imported of context.getModuleInfo(id)?.importedIds ?? []) pending.push(imported);
  }

  return { files, hoistedFrom };
}

/**
 * Stylesheets the client build already published, indexed by content.
 *
 * Both builds compile the same sources, so a stylesheet a route resolves from
 * the server graph is usually byte-for-byte one the client build emitted — an
 * island's, most often, since islands are now chunks in both. Pointing at the
 * published copy keeps one URL for one stylesheet instead of making a visitor
 * download the same bytes twice under two names.
 */
function indexClientStylesheets(root: string, base: string): Map<string, string> {
  const clientOutDir = resolveClientOutDir(root);
  const index = new Map<string, string>();
  if (!clientOutDir) return index;

  const walk = (directory: string, prefix: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === ".vite") continue;
        walk(path, name);
      } else if (entry.name.endsWith(".css")) {
        try {
          index.set(readFileSync(path, "utf-8"), `${base}${name}`);
        } catch {
          // An unreadable file simply does not participate.
        }
      }
    }
  };

  walk(clientOutDir, "");
  return index;
}

export function createServerCssAssetsPlugin(options: { inlineCss: boolean }): Plugin {
  let isServerBundle = false;
  let serverOutDir: string | undefined;
  let root = process.cwd();
  let base = "/";
  let copyFiles: string[] = [];

  return {
    name: "pracht:server-css-assets",
    apply: "build",
    enforce: "post",

    config() {
      // A no-op for client builds; Vite only reads it when building for SSR.
      return { build: { ssrEmitAssets: true } };
    },

    configResolved(config) {
      isServerBundle = !!config.build.ssr;
      root = config.root ?? process.cwd();
      base = config.base || "/";
      serverOutDir = resolve(root, config.build.outDir);
    },

    generateBundle(_outputOptions, bundle) {
      const consumer = this.environment?.config?.consumer;
      if (!(consumer ? consumer === "server" : isServerBundle)) return;

      const projectRoot = resolve(root);
      const cssManifest: Record<string, string[]> = {};
      const cssContentManifest: Record<string, string> = {};
      const needed = new Set<string>();
      const neededAssets = new Set<string>();
      const owners = mapModulesToChunks(bundle);
      const publishedByContent = indexClientStylesheets(root, base);
      const hoisted = new Set<string>();

      const sourceOf = (file: string): string | undefined => {
        const asset = bundle[file];
        if (!asset || asset.type !== "asset") return undefined;
        const source = (asset as Rollup.OutputAsset).source;
        return typeof source === "string" ? source : Buffer.from(source).toString("utf-8");
      };

      // A stylesheet the client build already published is served from there;
      // only what is unique to this build has to be copied out.
      const urls = new Map<string, string>();
      const urlFor = (file: string): string => {
        const known = urls.get(file);
        if (known !== undefined) return known;
        const source = sourceOf(file);
        const published = source === undefined ? undefined : publishedByContent.get(source);
        const url = published ?? `${base}${file}`;
        if (!published) needed.add(file);
        if (options.inlineCss && source !== undefined) cssContentManifest[url] = source;
        urls.set(file, url);
        return url;
      };

      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        const chunk = output as Rollup.OutputChunk;
        const facade = chunk.facadeModuleId;
        // Only real source files: a route or shell is looked up by its path, so
        // virtual ids and dependencies have no entry to contribute.
        if (!facade || !isAbsolute(facade) || facade.includes("node_modules")) continue;
        const relativePath = relative(projectRoot, facade.split("?")[0]!).replace(/\\/g, "/");
        if (relativePath.startsWith("..")) continue;

        // A route renders the URL of an imported asset into its markup whether
        // or not it has any CSS, so this is collected before the CSS check
        // below returns.
        for (const file of collectChunkAssets(bundle, chunk.fileName)) neededAssets.add(file);

        const css = new Set(collectChunkCss(bundle, chunk.fileName));
        const missing = collectHoistedCss(this, facade, owners, css);
        for (const file of missing.files) css.add(file);
        for (const id of missing.hoistedFrom) hoisted.add(id);
        if (css.size === 0) continue;

        cssManifest[relativePath] = [...css].map(urlFor);
      }

      if (hoisted.size > 0) {
        const list = [...hoisted]
          .map((id) => relative(projectRoot, id).replace(/\\/g, "/"))
          .sort()
          .join(", ");
        this.warn(
          `[pracht] ${list} ${hoisted.size === 1 ? "is" : "are"} bundled into the server entry, ` +
            "so the stylesheet carrying it also holds other routes' CSS. The routes that import " +
            "it are linking that whole stylesheet rather than their own; import it from a route, " +
            "a shell, or an island to keep the split.",
        );
      }

      // The stylesheets alone are not the deployable set: whatever they point
      // at travels with them, and so does whatever the routes themselves
      // import. `writeBundle` skips any name the client build already holds.
      copyFiles = [...needed, ...collectReferencedAssets(bundle, needed, base), ...neededAssets];

      // The generated server module carries the tokens; other chunks never do.
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        const chunk = output as Rollup.OutputChunk;
        if (!chunk.code.includes(ROUTE_CSS_MANIFEST_TOKEN)) continue;
        chunk.code = chunk.code
          .replace(ROUTE_CSS_MANIFEST_TOKEN, escapeForStringLiteral(JSON.stringify(cssManifest)))
          .replace(
            ROUTE_CSS_CONTENT_TOKEN,
            escapeForStringLiteral(JSON.stringify(cssContentManifest)),
          );
      }
    },

    writeBundle() {
      if (copyFiles.length === 0 || !serverOutDir) return;
      const clientOutDir = resolveClientOutDir(root);
      if (!clientOutDir || resolve(clientOutDir) === resolve(serverOutDir)) return;

      for (const file of copyFiles) {
        const from = join(serverOutDir, file);
        const to = join(clientOutDir, file);
        // Asset names are content-hashed, so a name that is already there is
        // the same stylesheet the client build emitted.
        if (!existsSync(from) || existsSync(to)) continue;
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(from, to);
      }
      copyFiles = [];
    },
  };
}
