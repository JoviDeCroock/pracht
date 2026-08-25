/**
 * Which changed files force the generated client entry to reload.
 *
 * The virtual client module bakes per-route hints — notably "does this route
 * export `head`" — plus `defineFont()` style and preload state. Neither can be
 * patched into an open page by HMR, so a change to either has to reload the
 * document. Everything else about a route or shell edit is ordinary component
 * HMR, and reloading for it costs the developer their client state.
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

export function reachesHeadBearingModule(
  modules: readonly HotUpdateModuleLike[],
  serverRoot: string,
  headHints: Record<string, boolean>,
  options: { startAtImporters?: boolean } = {},
): boolean {
  // A route or shell that exports `head` is head-bearing by definition, so
  // starting at the changed module itself would report every edit to such a
  // file as a head change. That is the caller's own case
  // (`changesRouteHeadSource`), handled separately by comparing hints. What
  // this walk is for is the *other* direction: a module like `src/fonts.ts`
  // whose generated style/preload state only exists in the virtual entry,
  // reached through the head-bearing modules that import it.
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
      if (headHints[relative] === true) return true;
    }

    if (module.importers) pending.push(...module.importers);
  }
  return false;
}
