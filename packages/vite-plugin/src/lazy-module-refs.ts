const LAZY_MODULE_REF = /\(\)\s*=>\s*import\(\s*(['"])([^'"]+)\1\s*\)/g;
// A ref position: a property value, a later call argument, an array element.
const LAZY_MODULE_REF_IN_REF_POSITION = new RegExp(`(?<=[:,[]\\s*)${LAZY_MODULE_REF.source}`, "g");

/**
 * Turn `() => import("./path")` module refs into `"./path"`, so the framework's
 * string-based file resolution sees them and the bundler does not rewrite the
 * specifier to a hashed chunk. In the app manifest every such arrow is a ref.
 * A module the manifest imports is ordinary code too: with `refPositionsOnly`,
 * `const load = () => import("./data.ts")` or `lazy(() => import("./Page.tsx"))`
 * there stays an executable function.
 */
export function stringifyLazyModuleRefs(
  code: string,
  { refPositionsOnly = false }: { refPositionsOnly?: boolean } = {},
): string {
  return code.replace(
    refPositionsOnly ? LAZY_MODULE_REF_IN_REF_POSITION : LAZY_MODULE_REF,
    "$1$2$1",
  );
}
