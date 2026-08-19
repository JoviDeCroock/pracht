// Type declarations for build-time `?pracht` image imports (enabled by the
// `prachtImage()` Vite plugin from "@pracht/image/vite").
//
// Reference this file once in your app, either with a triple-slash directive
// in any .d.ts file:
//
//   /// <reference types="@pracht/image/client" />
//
// or via tsconfig: `"types": ["@pracht/image/client"]`.

declare module "*?pracht" {
  const metadata: import("@pracht/image").PrachtImageMetadata;
  export const src: string;
  export const width: number;
  export const height: number;
  /** Undefined for SVG sources (vectors scale cleanly without a blur). */
  export const blurDataURL: string | undefined;
  export default metadata;
}

declare module "*?pracht&pracht-static" {
  const metadata: import("@pracht/image").PrachtImageMetadata;
  export const src: string;
  export const width: number;
  export const height: number;
  export const blurDataURL: string | undefined;
  /** Undefined for unprocessed root-relative publicDir sources. */
  export const variants: readonly import("@pracht/image").PrachtImageVariant[] | undefined;
  export default metadata;
}
