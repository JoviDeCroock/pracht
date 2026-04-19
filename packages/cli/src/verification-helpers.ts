import { relative } from "node:path";

export const CONFIG_FILE_NAMES = new Set([
  "vite.config.ts",
  "vite.config.mts",
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.cjs",
  "vite.config.cts",
]);

export const MODULE_SOURCE_RE = /\.(ts|tsx|js|jsx)$/;
export const PAGE_SOURCE_RE = /\.(ts|tsx|js|jsx|md|mdx)$/;

export interface Check {
  message: string;
  status: "ok" | "warning" | "error";
}

export function createCheck(status: Check["status"], message: string): Check {
  return { message, status };
}

export function isWithinDirectory(filePath: string, directoryPath: string): boolean {
  const relativePath = relative(directoryPath, filePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !relativePath.startsWith("../"));
}

export function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

export function toModuleSpecifier(fromDir: string, filePath: string): string {
  const relativePath = relative(fromDir, filePath).replace(/\\/g, "/");
  if (relativePath.startsWith(".")) {
    return relativePath;
  }
  return `./${relativePath}`;
}

export function normalizeRoutePath(path: string): string {
  if (!path || path === "/") {
    return "/";
  }

  const withLeadingSlash = path.startsWith("/") ? path : `/${path}`;
  const collapsed = withLeadingSlash.replace(/\/{2,}/g, "/");
  return collapsed.length > 1 && collapsed.endsWith("/") ? collapsed.slice(0, -1) : collapsed;
}

export function resolveApiRoutePath(apiDir: string, file: string): string {
  let relativePath = relative(apiDir, file).replace(/\\/g, "/");
  relativePath = relativePath.replace(/\.(ts|tsx|js|jsx)$/, "");

  if (relativePath === "index") {
    relativePath = "";
  } else {
    relativePath = relativePath.replace(/\/index$/, "");
  }

  relativePath = relativePath.replace(/\[\.\.\.[^\]]+\]/g, "*");
  relativePath = relativePath.replace(/\[([^\]]+)\]/g, ":$1");

  return normalizeRoutePath(relativePath ? `/api/${relativePath}` : "/api");
}
