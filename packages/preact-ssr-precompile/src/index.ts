/** Public Vite plugin facade for Preact SSR JSX precompilation. */

import type { Plugin } from "vite";
import { withMagicString } from "rolldown-string";
import { looksLikeJSX, stripQuery } from "./module-source.js";
import { createSimpleFilter } from "./plugin-filter.js";
import { transformPreactSsrMagicString } from "./transform.js";
import type { PreactSsrPrecompileOptions } from "./types.js";

export { transformPreactSsrJsx } from "./transform.js";
export type { PreactSsrPrecompileOptions, TransformPreactSsrJsxOptions } from "./types.js";

const DEFAULT_INCLUDE = [/\.[cm]?[tj]sx?$/];
const DEFAULT_EXCLUDE = [/node_modules/];

/**
 * Create a Vite/Rolldown plugin that precompiles safe Preact JSX for server
 * bundles into `jsxTemplate()` calls understood by `preact-render-to-string`.
 */
export function preactSsrPrecompile(options: PreactSsrPrecompileOptions = {}): Plugin {
  const filter = createSimpleFilter(
    options.include ?? DEFAULT_INCLUDE,
    options.exclude ?? DEFAULT_EXCLUDE,
  );
  const ssrOnly = options.ssrOnly ?? true;

  return {
    name: "preact-ssr-precompile",
    enforce: "pre",

    transform: {
      filter: {
        id: /\.[cm]?[jt]sx?(?:$|\?)/,
      },
      handler: withMagicString(function (s, id, transformOptions?: any) {
        const filename = stripQuery(id);
        if (ssrOnly && transformOptions?.ssr !== true) return;
        if (!filter(filename)) return;
        if (!looksLikeJSX(s.original)) return;

        transformPreactSsrMagicString(s, filename, options);
      }),
    },
  };
}

export default preactSsrPrecompile;
