import { isAbsolute, relative, resolve, sep } from "node:path";

import { normalizeRoutePath } from "./route-path.ts";

// Filesystem path helpers. Route-path normalization lives in the node-free
// `./route-path.ts` so the runtime entry can share it; re-export it here for
// the filesystem-backed callers that already import both.
export { normalizeRoutePath };

export function normalizeRelativeSource(root: string, source: string): string {
  const absolute = resolve(root, source);
  const fromRoot = relative(root, absolute);
  if (fromRoot === "" || relativePathEscapesRoot(fromRoot)) {
    throw new TypeError(
      `Content source ${JSON.stringify(source)} must stay inside the collection root.`,
    );
  }
  return fromRoot.split(sep).join("/");
}

export function isInsideRoot(root: string, source: string): boolean {
  const fromRoot = relative(root, resolve(source));
  return !relativePathEscapesRoot(fromRoot);
}

export function relativePathEscapesRoot(
  fromRoot: string,
  pathIsAbsolute: (path: string) => boolean = isAbsolute,
  separator = sep,
): boolean {
  return pathIsAbsolute(fromRoot) || fromRoot === ".." || fromRoot.startsWith(`..${separator}`);
}

export function artifactFileName(path: string): string {
  const normalized = normalizeRoutePath(path, "content artifact path");
  if (normalized === "/") {
    throw new TypeError("content artifact path must name a file below the site root.");
  }
  if (normalized.includes("%")) {
    throw new TypeError(
      "content artifact path must use canonical ASCII URL segments without percent encoding.",
    );
  }
  const fileName = normalized.slice(1);
  const rootControlFile = fileName.split("/", 1)[0].toLowerCase();
  if (["_headers", "_redirects"].includes(rootControlFile)) {
    throw new TypeError(
      `content artifact path must not replace Netlify's reserved root /${rootControlFile} control file.`,
    );
  }
  const segments = fileName.split("/");
  if (segments.some((segment) => segment === "")) {
    throw new TypeError("content artifact path must not contain empty segments.");
  }
  if (segments.some(pathSegmentIsNotPortableFileName)) {
    throw new TypeError(
      "content artifact path must use portable filesystem-safe segments without Windows-reserved names, trailing dots, or invalid filename characters.",
    );
  }
  return fileName;
}

function pathSegmentIsNotPortableFileName(segment: string): boolean {
  return (
    /[<>:"|?*]/.test(segment) ||
    segment.endsWith(".") ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)
  );
}
