import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { OutputAsset, OutputBundle, OutputChunk, Plugin } from "rollup";

import { resolveClientOutDir } from "./plugin-assets.ts";

/**
 * Stylesheets for routes that are not in the client bundle.
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
  bundle: OutputBundle,
  fileName: string,
  seen = new Set<string>(),
  isRoot = true,
): string[] {
  if (seen.has(fileName)) return [];
  seen.add(fileName);
  const output = bundle[fileName];
  if (!output || output.type !== "chunk") return [];
  const chunk = output as OutputChunk & { viteMetadata?: { importedCss?: Set<string> } };
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

      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        const chunk = output as OutputChunk;
        const facade = chunk.facadeModuleId;
        // Only real source files: a route or shell is looked up by its path, so
        // virtual ids and dependencies have no entry to contribute.
        if (!facade || !isAbsolute(facade) || facade.includes("node_modules")) continue;
        const relativePath = relative(projectRoot, facade.split("?")[0]!).replace(/\\/g, "/");
        if (relativePath.startsWith("..")) continue;

        const css = [...new Set(collectChunkCss(bundle, chunk.fileName))];
        if (css.length === 0) continue;

        cssManifest[relativePath] = css.map((file) => `${base}${file}`);
        for (const file of css) needed.add(file);
      }

      if (options.inlineCss) {
        for (const file of needed) {
          const asset = bundle[file];
          if (!asset || asset.type !== "asset") continue;
          const source = (asset as OutputAsset).source;
          cssContentManifest[`${base}${file}`] =
            typeof source === "string" ? source : Buffer.from(source).toString("utf-8");
        }
      }

      copyFiles = [...needed];

      // The generated server module carries the tokens; other chunks never do.
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        const chunk = output as OutputChunk;
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
