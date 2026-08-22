// Type declarations for the Markdown route modules that a
// `defineMarkdownCollection()` collection compiles through the `prachtContent()`
// Vite plugin.
//
// Without these, every `route("/docs/guide", () => import("./guide.md"))` entry
// in a route manifest fails typecheck with TS2307.
//
// Reference this file once in your app, either with a triple-slash directive
// in any .d.ts file:
//
//   /// <reference types="@pracht/markdown/client" />
//
// or via tsconfig: `"types": ["@pracht/markdown/client"]`.

declare module "*.md" {
  /** The exact original Markdown source, for `Accept: text/markdown` negotiation. */
  export const markdown: string;
  /** The serializable head object produced by the collection's `head()` hook. */
  export function head(): Record<string, unknown>;
  export const Component: import("preact").FunctionComponent;
}

declare module "*.markdown" {
  export const markdown: string;
  export function head(): Record<string, unknown>;
  export const Component: import("preact").FunctionComponent;
}
