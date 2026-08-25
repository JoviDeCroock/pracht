/**
 * Which changed files reach routes with generated client hints.
 *
 * Head and response-header hints decide whether a dependency edit must reload
 * the document; loader hints decide whether it must re-fetch active route data.
 * The importer walk is shared because all three are keyed by route source.
 */

// Local copy, matching plugin-codegen.ts: the helper is three lines and a
// shared module for it would be a larger change than the duplication.
function toPosixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

export interface HotUpdateModuleLike {
  file?: string | null;
  id?: string | null;
  importers?: Set<HotUpdateModuleLike>;
}

export function reachesRouteHintedModule(
  modules: readonly HotUpdateModuleLike[],
  serverRoot: string,
  routeHints: Record<string, boolean>,
  options: { startAtImporters?: boolean } = {},
): boolean {
  // A route or shell that owns a hint matches by definition, so starting at the
  // changed module itself would report every edit to that source as a
  // dependency change. The caller handles route sources separately; this walk
  // follows the other direction, from a changed dependency to hinted importers.
  const pending = options.startAtImporters
    ? modules.flatMap((module) => [...(module.importers ?? [])])
    : [...modules];
  const seen = new Set<HotUpdateModuleLike>();
  while (pending.length > 0) {
    const module = pending.pop();
    if (!module || seen.has(module)) continue;
    seen.add(module);

    const modulePath = module.file ?? module.id?.split("?", 1)[0];
    if (modulePath) {
      const normalizedPath = toPosixPath(modulePath);
      const relative = normalizedPath.startsWith(serverRoot)
        ? normalizedPath.slice(serverRoot.length)
        : normalizedPath;
      if (routeHints[relative] === true) return true;
    }

    if (module.importers) pending.push(...module.importers);
  }
  return false;
}
