/**
 * The app root registration, read from the manifest source.
 *
 * `defineApp({ root })` names the module, but `defineApp()` does not carry it
 * at runtime: the manifest ships in every client bundle, and an app without a
 * root must not pay for the key. The build reads it here instead and emits
 * the three things that follow from it — the client entry's static import,
 * the server registry entry, and the `__PRACHT_APP_ROOT__` define — so all
 * three always agree.
 *
 * In pages mode the synthesized manifest carries `root` for a pages-root
 * `_root.{ts,tsx,js,jsx}`, so both routers go through the same reader.
 */
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";

import {
  extractDefineAppObjectBody,
  maskCommentsAndStrings,
  scanTopLevelProperties,
} from "@pracht/capabilities/static";

import { appManifestDir, readAppManifestSource } from "./plugin-capabilities.ts";
import { resolveOptions, type PrachtPluginOptions } from "./plugin-options.ts";

export interface AppRootModule {
  /** The ref as the manifest writes it, e.g. `"./root.tsx"`. */
  ref: string;
  /** The module's project-root-absolute id, e.g. `"/src/root.tsx"`. */
  id: string;
}

const MODULE_REF = /^(?:\(\s*\)\s*=>\s*import\(\s*(["'])([^"']+)\1\s*\)|(["'])([^"']+)\3)$/;

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
  const resolved = resolveOptions(options);

  let source: string;
  try {
    source = readAppManifestSource(resolved, root);
  } catch {
    return null;
  }
  const body = extractDefineAppObjectBody(source);
  if (body === null) return null;

  const value = scanTopLevelProperties(body).get("root");
  if (value === undefined) {
    // Shorthand (`defineApp({ root })`) names a variable the build cannot read.
    if (/(?:^|[{,])\s*root\s*(?:,|$)/.test(maskCommentsAndStrings(body))) {
      throw unreadableRoot("root");
    }
    return null;
  }

  const match = MODULE_REF.exec(value);
  if (!match) throw unreadableRoot(value);
  const ref = match[2] ?? match[4];
  const absolute = ref.startsWith("/")
    ? resolve(root, ref.slice(1))
    : resolve(appManifestDir(resolved, root), ref);
  if (!existsSync(absolute)) {
    throw new Error(
      `[pracht] defineApp({ root }) names ${JSON.stringify(ref)}, but ${absolute} does not exist. ` +
        "Write the path with its extension, relative to the app manifest.",
    );
  }
  return { ref, id: `/${relative(root, absolute).replace(/\\/g, "/")}` };
}

function unreadableRoot(value: string): Error {
  return new Error(
    `[pracht] defineApp({ root }) must be a string path or a \`() => import("…")\` literal ` +
      `written inside defineApp({ … }) so the build can bundle the module; found \`${value}\`.`,
  );
}
