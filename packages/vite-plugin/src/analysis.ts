/**
 * One reader for what the build knows about an app's source files without
 * running them.
 *
 * Every consumer — the registries, the route hint tables, the hydration
 * exclusions, the pages scanner, the dev server's hot-update path — asks its
 * question here rather than reading and parsing files itself, so two readers
 * can never disagree about the same file, and an unchanged file is parsed once
 * per version however many of them ask. Facts are keyed by `ModuleId`, the one
 * spelling of a module every lookup canonicalizes to.
 */
import { invalidatePageFacts } from "./pages-router.ts";
import type { ResolvedPrachtPluginOptions } from "./plugin-options.ts";
import { moduleIdPath, type ModuleId } from "./module-id.ts";
import {
  invalidateModuleFacts,
  readModuleFacts,
  type FileStamp,
  type ModuleFacts,
} from "./route-loader-hints.ts";

export {
  canonicalModuleId,
  fileModuleId,
  isWithinRoot,
  moduleIdPath,
  type ModuleId,
} from "./module-id.ts";
export type { FileStamp, ModuleFacts } from "./route-loader-hints.ts";

export interface AnalysisSession {
  /** The facts of one module, or `null` when it cannot be read. One parse per file stamp. */
  module(id: ModuleId, stamp?: FileStamp): ModuleFacts | null;
  /** Forget what was read from `file` (absolute), or from every file. */
  invalidate(file?: string): void;
}

const sessions = new Map<string, AnalysisSession>();

/** The analysis session for an app at `root` with these plugin options. */
export function getAnalysisSession(
  resolved: ResolvedPrachtPluginOptions,
  root: string = process.cwd(),
): AnalysisSession {
  const key = JSON.stringify([
    root,
    resolved.appFile,
    resolved.pagesDir,
    resolved.routesDir,
    resolved.shellsDir,
    resolved.middlewareDir,
    resolved.serverDir,
    resolved.additionalExtensions,
  ]);
  let session = sessions.get(key);
  if (!session) {
    session = createAnalysisSession(root);
    sessions.set(key, session);
  }
  return session;
}

function createAnalysisSession(root: string): AnalysisSession {
  return {
    module: (id, stamp) => readModuleFacts(moduleIdPath(root, id), stamp),
    invalidate(file) {
      invalidateModuleFacts(file);
      invalidatePageFacts(file);
    },
  };
}
