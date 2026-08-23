// Route-path normalization shared by the authoring collection, the generated
// runtime snapshot, and the loader/capability helpers. It stays free of
// `node:*` imports so `@pracht/content/runtime` keeps working on workerd and
// other filesystem-free deployment targets.

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

export function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point !== undefined && (point <= 0x1f || point === 0x7f)) return true;
  }
  return false;
}
