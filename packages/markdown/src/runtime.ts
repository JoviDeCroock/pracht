import { getImageProps, type PrachtImageMetadata } from "@pracht/image";

import type { MarkdownImageDescriptor, MarkdownImageOptions } from "./types.ts";

const ALLOWED_ATTRIBUTES = new Set([
  "src",
  "alt",
  "title",
  "width",
  "height",
  "srcset",
  "sizes",
  "loading",
  "decoding",
  "fetchpriority",
  "style",
]);

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function serializeStyle(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.entries(value)
    .filter(
      ([, entry]) => entry != null && (typeof entry === "string" || typeof entry === "number"),
    )
    .map(([property, entry]) => {
      const name = property.startsWith("--")
        ? property
        : property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
      return `${name}:${String(entry)}`;
    })
    .join(";");
}

/** Serialize the exact safe `<img>` subset emitted by Markdown routes. */
export function renderMarkdownImage(
  descriptor: MarkdownImageDescriptor,
  metadata: PrachtImageMetadata,
  options: MarkdownImageOptions = {},
): string {
  const props = getImageProps({
    src: metadata,
    alt: descriptor.alt,
    ...(descriptor.title === undefined ? {} : { title: descriptor.title }),
    sizes: options.sizes ?? "100vw",
    placeholder: options.placeholder ?? "empty",
    ...(options.quality === undefined ? {} : { quality: options.quality }),
  });

  const attributes: string[] = [];
  for (const [rawName, rawValue] of Object.entries(props)) {
    const name = rawName === "srcSet" ? "srcset" : rawName.toLowerCase();
    if (!ALLOWED_ATTRIBUTES.has(name) || rawValue == null || rawValue === false) continue;
    const value = name === "style" ? serializeStyle(rawValue) : String(rawValue);
    if (value === undefined) continue;
    attributes.push(`${name}="${escapeAttribute(value)}"`);
  }
  return `<img ${attributes.join(" ")}>`;
}

export function renderMarkdownImages(
  html: string,
  descriptors: readonly MarkdownImageDescriptor[],
  metadata: readonly PrachtImageMetadata[],
  options: MarkdownImageOptions = {},
): string {
  if (descriptors.length !== metadata.length) {
    throw new Error(
      `[pracht/markdown] Expected ${descriptors.length} image metadata entries, received ${metadata.length}.`,
    );
  }
  let rendered = html;
  descriptors.forEach((descriptor, index) => {
    const occurrences = rendered.split(descriptor.marker).length - 1;
    if (occurrences !== 1) {
      throw new Error(
        `[pracht/markdown] Expected exactly one compiled image marker for ${JSON.stringify(descriptor.source)}, found ${occurrences}.`,
      );
    }
    rendered = rendered.replace(
      descriptor.marker,
      renderMarkdownImage(descriptor, metadata[index], options),
    );
  });
  return rendered;
}
