/** Sharp lifecycle, passthrough policy, and output codec negotiation. */

import type { ImageFailure, ImageOutputFormat, TransformImageResult } from "./node-types.ts";

const SHARP_INSTALL_HINT =
  'Image optimization requires the optional "sharp" dependency. ' +
  'Install it in your app with "pnpm add sharp" (or npm install / yarn add) ' +
  "to enable the pracht image endpoint.";

/** Minimal structural typing for the parts of sharp we use. */
interface SharpPipeline {
  rotate(): SharpPipeline;
  resize(options: { width: number; withoutEnlargement: boolean }): SharpPipeline;
  avif(options: { quality: number }): SharpPipeline;
  webp(options: { quality: number }): SharpPipeline;
  jpeg(options: { quality: number }): SharpPipeline;
  png(): SharpPipeline;
  toBuffer(): Promise<Uint8Array>;
}

type SharpFactory = (input: Uint8Array) => SharpPipeline;

export interface ImageTransformerOptions {
  formats: ImageOutputFormat[];
  loadSharp?: () => Promise<unknown>;
}

export function createImageTransformer(options: ImageTransformerOptions) {
  const importSharp = createSharpImporter(options.loadSharp ?? (() => import("sharp")));

  return async function transformImage(input: {
    accept: string;
    bytes: Uint8Array;
    contentType: string;
    quality: number;
    source: string;
    width: number;
  }): Promise<TransformImageResult> {
    // SVG and GIF pass through untouched: sharp cannot meaningfully resize
    // them here (vector / animation). SVG additionally gets a download
    // disposition so an allowlisted remote SVG cannot run scripts same-origin
    // when opened directly.
    if (input.contentType === "image/svg+xml" || input.contentType === "image/gif") {
      return {
        ok: true,
        bytes: input.bytes,
        contentType: input.contentType,
        ...(input.contentType === "image/svg+xml" ? { contentDisposition: "attachment" } : {}),
      };
    }

    let sharp: SharpFactory;
    try {
      sharp = await importSharp();
    } catch {
      return failure(500, SHARP_INSTALL_HINT);
    }

    let pipeline = sharp(input.bytes)
      .rotate()
      .resize({ width: input.width, withoutEnlargement: true });
    let contentType: string;
    if (options.formats.includes("image/avif") && acceptsFormat(input.accept, "image/avif")) {
      pipeline = pipeline.avif({ quality: input.quality });
      contentType = "image/avif";
    } else if (
      options.formats.includes("image/webp") &&
      acceptsFormat(input.accept, "image/webp")
    ) {
      pipeline = pipeline.webp({ quality: input.quality });
      contentType = "image/webp";
    } else if (input.contentType === "image/png") {
      pipeline = pipeline.png();
      contentType = "image/png";
    } else {
      pipeline = pipeline.jpeg({ quality: input.quality });
      contentType = "image/jpeg";
    }

    try {
      return { ok: true, bytes: await pipeline.toBuffer(), contentType };
    } catch {
      return failure(500, `Failed to optimize source image "${input.source}".`);
    }
  };
}

function createSharpImporter(load: () => Promise<unknown>): () => Promise<SharpFactory> {
  let cached: Promise<SharpFactory> | undefined;
  return () => {
    cached ??= load().then(
      (mod) => ((mod as { default?: unknown }).default ?? mod) as SharpFactory,
      (error) => {
        cached = undefined;
        throw error;
      },
    );
    return cached;
  };
}

function acceptsFormat(accept: string, format: string): boolean {
  return accept.split(",").some((entry) => {
    const [mediaType, ...parameters] = entry.split(";");
    if (mediaType.trim().toLowerCase() !== format) return false;

    for (const parameter of parameters) {
      const [name, value] = parameter.trim().split("=");
      if (name?.toLowerCase() === "q" && Number(value) === 0) return false;
    }
    return true;
  });
}

function failure(status: number, message: string): ImageFailure {
  return { ok: false, status, message };
}
