import prefresh from "@prefresh/vite";
import type { Plugin } from "vite";

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
      config(_config, env) {
        return {
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
