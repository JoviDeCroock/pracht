/** Shared public options for the SSR precompiler plugin and transform API. */

export type FilterPattern = string | RegExp | ReadonlyArray<string | RegExp>;

export interface TransformPreactSsrJsxOptions {
  /** JSX runtime import source. Imports are generated from `${importSource}/jsx-runtime`. */
  importSource?: string;
  /** Additional lowercase HTML element names to keep on the normal JSX path. */
  skipElements?: string[];
  /** Attributes that should always be serialized at runtime with `jsxAttr()`. */
  dynamicProps?: string[];
}

export interface PreactSsrPrecompileOptions extends TransformPreactSsrJsxOptions {
  /** Files to transform. Defaults to JS/TS files, including JSX/TSX. */
  include?: FilterPattern;
  /** Files to skip. Defaults to node_modules. */
  exclude?: FilterPattern;
  /** Run only for Vite SSR transforms. Defaults to true. */
  ssrOnly?: boolean;
}
