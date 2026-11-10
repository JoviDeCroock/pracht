import prefresh from "@prefresh/vite";
import type { Plugin, Rolldown } from "vite";

import { PRACHT_CLIENT_MODULE_ID, PRACHT_ISLANDS_CLIENT_MODULE_ID } from "./plugin-assets.ts";

/**
 * React package names resolved to Preact's compatibility layer, so a React
 * component library works without per-app `resolve.alias` configuration.
 */
const REACT_ALIASES = {
  "react-dom/test-utils": "preact/test-utils",
  "react-dom": "preact/compat",
  "react/jsx-runtime": "preact/jsx-runtime",
  react: "preact/compat",
};

/** Parser features prefresh's Babel pass must accept in application source. */
const PREFRESH_PARSER_PLUGINS = ["importMeta", "explicitResourceManagement", "topLevelAwait"];

type WarningHandler = NonNullable<Rolldown.InputOptions["onwarn"]>;

/**
 * Bundling drops module-level `"use client"` directives, which only mean
 * something to React Server Components. Libraries in `node_modules` ship them
 * for React and the warning is not actionable, so keep it out of build output
 * and hand every other warning to the app's own handler.
 */
function silenceUseClientDirectives(appHandler: WarningHandler | undefined): WarningHandler {
  return (warning, defaultHandler) => {
    if (warning.code === "MODULE_LEVEL_DIRECTIVE" && warning.message.includes("use client")) {
      return;
    }
    if (appHandler) appHandler(warning, defaultHandler);
    else defaultHandler(warning);
  };
}

const DEV_CLIENT_ENTRY_IDS = new Set([PRACHT_CLIENT_MODULE_ID, PRACHT_ISLANDS_CLIENT_MODULE_ID]);

/**
 * The Preact integration pracht needs from Vite: the automatic JSX runtime
 * through Vite's own Oxc transform, the React aliases, Preact DevTools in
 * development, and Fast Refresh.
 */
export function createPreactPlugins(): Plugin[] {
  return [
    {
      name: "pracht:preact",
      enforce: "pre",
      config(config, env) {
        const appOnwarn =
          config.build?.rolldownOptions?.onwarn ?? config.build?.rollupOptions?.onwarn;
        return {
          build: { rolldownOptions: { onwarn: silenceUseClientDirectives(appOnwarn) } },
          resolve: { alias: REACT_ALIASES },
          oxc: { jsx: { runtime: "automatic", importSource: "preact" } },
          optimizeDeps: {
            include: [
              "preact",
              "preact/jsx-runtime",
              "preact/jsx-dev-runtime",
              ...(env.command === "serve" ? ["preact/devtools"] : []),
            ],
            rolldownOptions: { transform: { jsx: { runtime: "automatic" } } },
          },
        };
      },
    },
    {
      // Connects the Preact DevTools browser extension. Only the client
      // entries need it: every component module loads after them.
      name: "pracht:preact-devtools",
      apply: "serve",
      transform: {
        filter: { id: /^virtual:pracht\/(?:islands-)?client$/ },
        handler(code, id, options) {
          if (options?.ssr || !DEV_CLIENT_ENTRY_IDS.has(id)) return null;
          return { code: `import "preact/devtools";\n${code}`, map: null };
        },
      },
    },
    prefresh({ parserPlugins: PREFRESH_PARSER_PLUGINS }) as Plugin,
  ];
}
