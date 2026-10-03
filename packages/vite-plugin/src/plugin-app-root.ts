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
import { existsSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

import { extractDefineAppObjectBody, maskCommentsAndStrings } from "@pracht/capabilities/static";
import { parseAst } from "vite";

import { getRolldownLang } from "./client-module-query.ts";
import { appManifestDir, readAppManifestSource } from "./plugin-capabilities.ts";
import { resolveOptions, type PrachtPluginOptions } from "./plugin-options.ts";

export interface AppRootModule {
  /** The ref as the manifest writes it, e.g. `"./root.tsx"`. */
  ref: string;
  /** The module's project-root-absolute id, e.g. `"/src/root.tsx"`. */
  id: string;
}

interface AstNode {
  type: string;
  [key: string]: unknown;
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
  const resolved = resolveOptions(options);

  let source: string;
  try {
    source = readAppManifestSource(resolved, root);
  } catch {
    return null;
  }
  const body = extractDefineAppObjectBody(source);
  if (body === null) return null;

  // Parsed rather than scanned, so only a top-level `root` counts: a nested
  // `shells: { root }` is somebody else's key.
  const objectSource = `({${body}\n})`;
  const lang = resolved.pagesDir ? "ts" : getRolldownLang(resolved.appFile);
  let object: AstNode;
  try {
    object = (parseAst(objectSource, { lang }).body[0] as unknown as AstNode).expression as AstNode;
  } catch (error) {
    if (!/\broot\b/.test(maskCommentsAndStrings(body))) return null;
    throw new Error(
      `[pracht] The build could not parse defineApp({ … }) to read its root: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const property = (object.properties as AstNode[]).find(
    (node) => node.type === "Property" && !node.computed && propertyName(node.key) === "root",
  );
  if (!property) return null;
  const ref = moduleRef(property.value as AstNode);
  if (ref === null) {
    // Shorthand (`defineApp({ root })`) names a variable the build cannot read.
    throw unreadableRoot(
      property.shorthand
        ? "root"
        : objectSource.slice(
            (property.value as AstNode).start as number,
            (property.value as AstNode).end as number,
          ),
    );
  }
  const absolute = ref.startsWith("/")
    ? resolve(root, ref.slice(1))
    : resolve(appManifestDir(resolved, root), ref);
  if (!existsSync(absolute) || statSync(absolute).isDirectory()) {
    throw new Error(
      `[pracht] defineApp({ root }) names ${JSON.stringify(ref)}, but ${absolute} ` +
        `${existsSync(absolute) ? "is a directory" : "does not exist"}. ` +
        "Write the path to the root module with its extension, relative to the app manifest.",
    );
  }
  return { ref, id: `/${relative(root, absolute).replace(/\\/g, "/")}` };
}

function propertyName(key: unknown): unknown {
  const node = key as AstNode;
  return node.type === "Identifier" ? node.name : node.type === "Literal" ? node.value : undefined;
}

/** `"./root.tsx"` or `() => import("./root.tsx")`, else `null`. */
function moduleRef(value: AstNode): string | null {
  if (value.type === "Literal" && typeof value.value === "string") return value.value;
  if (
    value.type === "ArrowFunctionExpression" &&
    (value.params as unknown[]).length === 0 &&
    (value.body as AstNode).type === "ImportExpression"
  ) {
    const specifier = (value.body as AstNode).source as AstNode;
    if (specifier.type === "Literal" && typeof specifier.value === "string") {
      return specifier.value;
    }
  }
  return null;
}

function unreadableRoot(value: string): Error {
  return new Error(
    `[pracht] defineApp({ root }) must be a string path or a \`() => import("…")\` literal ` +
      `written inside defineApp({ … }) so the build can bundle the module; found \`${value}\`.`,
  );
}
