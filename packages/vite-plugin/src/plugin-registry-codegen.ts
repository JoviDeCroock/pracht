import { resolveOptions, type PrachtPluginOptions } from "./plugin-options.ts";

/** Generate the lazy module registry shared by server and dev virtual modules. */
export function createPrachtRegistryModuleSource(options: PrachtPluginOptions = {}): string {
  const resolved = resolveOptions(options);
  const apiGlobs = [`${resolved.apiDir}/**/*.{ts,js,tsx,jsx}`, `!${resolved.apiDir}/**/*.d.ts`];
  const isPagesMode = !!resolved.pagesDir;

  const routeGlob = isPagesMode
    ? `${resolved.pagesDir}/**/*.{ts,tsx,js,jsx,md,mdx}`
    : `${resolved.routesDir}/**/*.{ts,tsx,js,jsx,md,mdx}`;
  const routeTsrxGlob = isPagesMode
    ? `${resolved.pagesDir}/**/*.tsrx`
    : `${resolved.routesDir}/**/*.tsrx`;

  const shellGlob = isPagesMode
    ? `${resolved.pagesDir}/**/_app.{ts,tsx,js,jsx}`
    : `${resolved.shellsDir}/**/*.{ts,tsx,js,jsx,md,mdx}`;
  const shellTsrxGlob = isPagesMode
    ? `${resolved.pagesDir}/**/_app.tsrx`
    : `${resolved.shellsDir}/**/*.tsrx`;

  return [
    `export const routeModules = {`,
    `  ...import.meta.glob(${JSON.stringify(routeGlob)}),`,
    `  ...import.meta.glob(${JSON.stringify(routeTsrxGlob)}),`,
    `};`,
    `export const shellModules = {`,
    `  ...import.meta.glob(${JSON.stringify(shellGlob)}),`,
    `  ...import.meta.glob(${JSON.stringify(shellTsrxGlob)}),`,
    `};`,
    `export const middlewareModules = import.meta.glob(${JSON.stringify(`${resolved.middlewareDir}/**/*.{ts,tsx,js,jsx}`)});`,
    `export const apiModules = import.meta.glob(${JSON.stringify(apiGlobs)});`,
    `export const dataModules = import.meta.glob(${JSON.stringify(`${resolved.serverDir}/**/*.{ts,js,tsx,jsx}`)});`,
    `export const capabilityModules = import.meta.glob(${JSON.stringify(`${resolved.capabilitiesDir}/**/*.{ts,js,tsx,jsx}`)});`,
    "",
    "export const registry = {",
    "  routeModules,",
    "  shellModules,",
    "  middlewareModules,",
    "  apiModules,",
    "  dataModules,",
    "  capabilityModules,",
    "};",
  ].join("\n");
}
