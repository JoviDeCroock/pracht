/**
 * The app root registration, read from the manifest source.
 *
 * `defineApp({ root })` names the module, but `defineApp()` does not carry it
 * at runtime: the manifest ships in every client bundle, and an app without a
 * root must not pay for the key. The build reads it here instead and emits
 * the three things that follow from it — the client entry's static import,
 * the server registry entry, and the `__PRACHT_APP_ROOT__` define — so all
 * three always agree. The client module transform reads it too, to strip the
 * server-only `dehydrate` from the browser copy of that module.
 *
 * The registration comes from the analysis session's manifest facts, which
 * read it from the same parse as every other manifest fact; in pages mode they
 * report the pages-root `_root.{ts,tsx,js,jsx}`, so both routers go through
 * the same reader.
 */
import { existsSync, statSync } from "node:fs";

import { getAnalysisSession, moduleIdPath } from "./analysis.ts";
import { resolveOptions, type PrachtPluginOptions } from "./plugin-options.ts";

export interface AppRootModule {
  /** The ref as the manifest writes it, e.g. `"./root.tsx"`. */
  ref: string;
  /** The module's project-root-absolute id, e.g. `"/src/root.tsx"`. */
  id: string;
}

/**
 * The module `defineApp({ root })` registers, or `null` when the app has none
 * (or no readable manifest). Throws when `root` is present but cannot be read
 * statically, or names a file that does not exist: a root the build silently
 * skipped would render on neither side.
 */
export function findAppRootModule(
  options: PrachtPluginOptions = {},
  root: string = process.cwd(),
): AppRootModule | null {
  const facts = getAnalysisSession(resolveOptions(options), root).manifest();
  if (facts.appRootError) throw new Error(facts.appRootError);
  if (!facts.appRoot) return null;
  const { ref, id } = facts.appRoot;
  const absolute = moduleIdPath(root, id);
  if (!existsSync(absolute) || statSync(absolute).isDirectory()) {
    throw new Error(
      `[pracht] defineApp({ root }) names ${JSON.stringify(ref)}, but ${absolute} ` +
        `${existsSync(absolute) ? "is a directory" : "does not exist"}. ` +
        "Write the path to the root module with its extension, relative to the app manifest.",
    );
  }
  return { ref, id };
}
