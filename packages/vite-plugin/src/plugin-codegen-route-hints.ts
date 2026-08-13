/** Generated helper shared by client and server virtual modules. */
export function createApplyRouteLoaderHintsSource(): string[] {
  return [
    "function applyRouteLoaderHints(resolvedApp, routeLoaderHints) {",
    "  for (const route of resolvedApp.routes) {",
    "    const hint = routeLoaderHints[route.file];",
    "    if (hint === true) {",
    "      route.hasLoader = true;",
    "    } else if (typeof route.hasLoader === 'undefined' && typeof hint === 'boolean') {",
    "      route.hasLoader = hint;",
    "    }",
    "  }",
    "}",
    "",
  ];
}
