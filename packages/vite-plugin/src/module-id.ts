import { relative, resolve, sep } from "node:path";

/**
 * A module's identity inside the project: its path relative to the project
 * root, POSIX separators, a leading `/`, no query, and every `.`/`..` segment
 * resolved — `/src/routes/home.tsx`. It is the key `import.meta.glob` gives a
 * file, so registries, hint tables, and every manifest reader agree on it.
 *
 * A module outside the root keeps its `..` segments (`/../shared/a.tsx`), so
 * `isWithinRoot()` can tell it apart; nothing resolves to such an id by
 * accident.
 */
export type ModuleId = string & { readonly __brand: "ModuleId" };

/**
 * The id of the module `ref` names when written in a module in `importerDir`.
 *
 * `/src/a.tsx` is root-absolute. Every other spelling — `./a.tsx`, `../a.tsx`,
 * and a bare `routes/a.tsx` — resolves against `importerDir`, which is how the
 * runtime registries read manifest refs. A query (`?pracht-client`) is not
 * part of a module's identity. A directory alias such as
 * `/src/other/../routes` resolves to the directory it names.
 */
export function canonicalModuleId(root: string, ref: string, importerDir: string): ModuleId {
  const path = ref.split("?")[0]!.replace(/\\/g, "/");
  const absolute = path.startsWith("/") ? resolve(root, `.${path}`) : resolve(importerDir, path);
  return `/${relative(root, absolute).replace(/\\/g, "/")}` as ModuleId;
}

/** The id of the file at absolute, normalized path `file`. */
export function fileModuleId(root: string, file: string): ModuleId {
  // Directory walks hand over thousands of paths under the root per save, so
  // the common case skips `path.relative()`.
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  const path = file.startsWith(prefix) ? file.slice(prefix.length) : relative(root, file);
  return `/${sep === "/" ? path : path.replace(/\\/g, "/")}` as ModuleId;
}

/** The absolute file path an id names. */
export function moduleIdPath(root: string, id: ModuleId): string {
  return resolve(root, `.${id}`);
}

/** Whether an id names a file inside the project root. */
export function isWithinRoot(id: ModuleId): boolean {
  return id !== "/.." && !id.startsWith("/../");
}

/** `path` with POSIX separators. */
export function toPosixPath(path: string): string {
  return path.replace(/\\/g, "/");
}
