import type { ImageProps } from "./image-types.ts";

interface ImageDiagnosticInput {
  src: string;
  fill: boolean;
  width: ImageProps["width"];
  height: ImageProps["height"];
  numericWidth: number | undefined;
  numericHeight: number | undefined;
  placeholder: ImageProps["placeholder"];
  resolvedBlurDataURL: string | undefined;
  safeBlurDataURL: string | undefined;
}

const warned = new Set<string>();

export function warnForImageProps(input: ImageDiagnosticInput): void {
  if (!isDevWarningsEnabled()) return;

  const {
    src,
    fill,
    width,
    height,
    numericWidth,
    numericHeight,
    placeholder,
    resolvedBlurDataURL,
    safeBlurDataURL,
  } = input;

  if (!fill && (numericWidth == null || numericHeight == null)) {
    warnOnce(
      `dimensions:${src}`,
      `[pracht/image] <Image src="${src}"> is missing required "width" and "height" props. ` +
        `Provide the intrinsic dimensions (or use the "fill" prop) so the browser can ` +
        `reserve space and avoid layout shift.`,
    );
  }
  if (fill && (width != null || height != null)) {
    warnOnce(
      `fill-dimensions:${src}`,
      `[pracht/image] <Image src="${src}"> uses "fill" together with "width"/"height". ` +
        `"fill" images size themselves to their positioned parent; remove the explicit dimensions.`,
    );
  }
  if (placeholder === "blur" && resolvedBlurDataURL == null) {
    warnOnce(
      `blur-missing:${src}`,
      `[pracht/image] <Image src="${src}"> uses placeholder="blur" without a blurDataURL. ` +
        `Import the image with the "?pracht" query (via prachtImage() from "@pracht/image/vite") ` +
        `or pass a blurDataURL prop. Rendering without a placeholder.`,
    );
  }
  if (resolvedBlurDataURL != null && safeBlurDataURL == null) {
    warnOnce(
      `blur-invalid:${src}`,
      `[pracht/image] <Image src="${src}"> received a blurDataURL that is not a ` +
        `well-formed "data:image/…" URI. It was ignored because interpolating arbitrary ` +
        `strings into the style attribute could inject CSS.`,
    );
  }
}

function getNodeEnv(): string | undefined {
  return (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env?.NODE_ENV;
}

// Every read must spell out `import.meta.env?.<KEY>` literally. Vite statically
// replaces those exact member expressions at build time, but a bare
// `import.meta.env` read is materialized into an object literal holding every
// exposed env value — including `VITE_`-prefixed ones — which would ship those
// values in the client bundle and slip past the name-based env leak scan. In
// Node (CLI builds, tests) `import.meta.env` is undefined and the optional
// chain yields undefined.
function getImportMetaDev(): boolean | undefined {
  const mode = import.meta.env?.MODE;
  if (mode === "production") return false;
  const dev = import.meta.env?.DEV;
  if (typeof dev === "boolean") return dev;
  if (typeof mode === "string") return mode !== "production";
  return undefined;
}

function isDevWarningsEnabled(): boolean {
  const nodeEnv = getNodeEnv();
  if (nodeEnv === "production") return false;
  if (typeof nodeEnv === "string") return true;

  return getImportMetaDev() ?? false;
}

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.error(message);
}
