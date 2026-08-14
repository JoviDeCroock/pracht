/** Preact JSX-to-`jsxTemplate()` lowering, independent from Vite plugin wiring. */

import { generateTransform, rolldownString, type RolldownString } from "rolldown-string";
import { TransformContext } from "./transform/context.js";
import {
  collectIdentifierNames,
  insertPrelude,
  parseProgram,
  type NodeLike,
} from "./transform/source.js";
import type { TransformPreactSsrJsxOptions } from "./types.js";

/** Transform JSX in a single module. Exposed for tests and non-Vite integrations. */
export function transformPreactSsrJsx(
  code: string,
  id = "preact-ssr.tsx",
  options: TransformPreactSsrJsxOptions = {},
): string | null {
  const s = rolldownString(code, id);
  const changed = transformPreactSsrMagicString(s, id, options);
  if (!changed) return null;
  const result = generateTransform(s, id, true);
  return result ? String(result.code) : null;
}

export function transformPreactSsrMagicString(
  s: RolldownString,
  id: string,
  options: TransformPreactSsrJsxOptions,
): boolean {
  let program: NodeLike;
  try {
    program = parseProgram(id, s.original);
  } catch (error) {
    // Bail out so the next plugin (e.g. @preact/preset-vite) can surface the
    // real parser diagnostics. Warn so silent skips are still discoverable.
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[preact-ssr-precompile] Skipping ${id}: ${message}`);
    return false;
  }

  const ctx = new TransformContext(s.original, options, collectIdentifierNames(program));
  const replacements = ctx.collectJsxReplacements(program);
  if (replacements.length === 0) return false;

  for (const replacement of replacements) {
    s.update(replacement.start, replacement.end, replacement.code);
  }
  insertPrelude(s, program, ctx.renderPrelude());
  return true;
}
