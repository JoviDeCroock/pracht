import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Match Vite's canonical module ids even when a path crosses a symlink,
 * including macOS' `/var` to `/private/var` alias. Missing files retain their
 * lexical identity so downstream code can report the precise path.
 */
export function canonicalFilePath(path: string): string {
  try {
    return toPosixPath(realpathSync.native(path));
  } catch {
    return toPosixPath(path);
  }
}

export function resolveConfigPath(root: string, configPath: string): string {
  const normalizedRoot = toPosixPath(root).replace(/\/$/, "");
  const relativePath = configPath.replace(/^\//, "");
  if (normalizedRoot.startsWith("/") && !/^[A-Za-z]:\//.test(normalizedRoot)) {
    return `${normalizedRoot}/${relativePath}`;
  }
  return toPosixPath(resolve(root, relativePath));
}

export function toPosixPath(path: string): string {
  return path.replace(/\\/g, "/");
}
