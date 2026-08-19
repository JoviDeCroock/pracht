import { relative, resolve, sep } from "node:path";

export function normalizeRoutePath(value: string, label = "content route"): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    throw new TypeError(`${label} must be a safe root-relative URL path.`);
  }

  if (value.split("/").some(pathSegmentIsUnsafe)) {
    throw new TypeError(`${label} must be a safe root-relative URL path.`);
  }

  const canonical = new URL(value, "http://pracht.local").pathname.replace(/\/{2,}/g, "/");
  return canonical.length > 1 ? canonical.replace(/\/+$/, "") : canonical;
}

function pathSegmentIsUnsafe(segment: string): boolean {
  try {
    const decoded = decodeURIComponent(segment);
    return (
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\") ||
      hasControlCharacter(decoded)
    );
  } catch {
    return true;
  }
}

export function normalizeRelativeSource(root: string, source: string): string {
  const absolute = resolve(root, source);
  const fromRoot = relative(root, absolute);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
    throw new TypeError(
      `Content source ${JSON.stringify(source)} must stay inside the collection root.`,
    );
  }
  return fromRoot.split(sep).join("/");
}

export function isInsideRoot(root: string, source: string): boolean {
  const fromRoot = relative(root, resolve(source));
  return fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`);
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
  if (fileName.split("/").some((segment) => segment === "")) {
    throw new TypeError("content artifact path must not contain empty segments.");
  }
  return fileName;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point !== undefined && (point <= 0x1f || point === 0x7f)) return true;
  }
  return false;
}
