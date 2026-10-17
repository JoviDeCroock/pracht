/**
 * Generates the route-scale fixture: one app with `routeCount` routes.
 *
 * The ladder fixture holds the app constant and varies the framework; this one
 * holds the framework constant and varies the number of routes, so the
 * measured growth is what each extra route adds to every page — the client
 * entry carries the manifest, the route-module map and the route hint tables.
 *
 * The app is written outside the repository (generated sources would otherwise
 * be picked up by the typecheck, formatter and linter) and borrows the ladder
 * fixture's installed dependencies through a `node_modules` symlink. Its shape
 * is fixed: the same `routeCount` always produces the same files.
 */
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SECTIONS = ["account", "billing", "products", "orders", "admin", "docs", "blog", "settings"];

/** The path of route `index`: one in three is dynamic, the first is `/`. */
export function scaleRoutePath(index) {
  if (index === 0) return "/";
  const section = SECTIONS[index % SECTIONS.length];
  return index % 3 === 0 ? `/${section}/item-${index}/:id` : `/${section}/page-${index}`;
}

/**
 * Writes the app into `dir`, replacing anything already there.
 *
 * Every route is server-rendered with full hydration, half of them have a
 * loader, and every page links to the next one with a plain anchor.
 */
export function writeScaleApp(dir, routeCount, nodeModulesDir) {
  rmSync(dir, { force: true, recursive: true });
  mkdirSync(join(dir, "src/routes"), { recursive: true });
  mkdirSync(join(dir, "src/shells"), { recursive: true });
  symlinkSync(nodeModulesDir, join(dir, "node_modules"), "dir");

  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: `bench-scale-${routeCount}`, private: true, type: "module" }, null, 2)}\n`,
  );
  writeFileSync(
    join(dir, "vite.config.ts"),
    [
      'import { defineConfig } from "vite";',
      'import { nodeAdapter } from "@pracht/adapter-node";',
      'import { pracht } from "@pracht/vite-plugin";',
      "",
      "export default defineConfig({ plugins: [pracht({ adapter: nodeAdapter() })] });",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "src/shells/site.tsx"),
    [
      'import type { ShellProps } from "@pracht/core";',
      "",
      "export function Shell({ children }: ShellProps) {",
      "  return <main>{children}</main>;",
      "}",
      "",
    ].join("\n"),
  );

  const routes = [];
  for (let index = 0; index < routeCount; index += 1) {
    const hasLoader = index % 2 === 0;
    const next = scaleRoutePath((index + 1) % routeCount).replace(":id", "1");
    const source = [
      hasLoader ? `export async function loader() {\n  return { index: ${index} };\n}\n` : "",
      `export function Component() {`,
      `  return (`,
      `    <section>`,
      `      <h1>Route ${index}</h1>`,
      `      <a href=${JSON.stringify(next)}>next</a>`,
      `    </section>`,
      `  );`,
      `}`,
      "",
    ].join("\n");
    writeFileSync(join(dir, `src/routes/r${index}.tsx`), source);
    routes.push(
      `    route(${JSON.stringify(scaleRoutePath(index))}, () => import("./routes/r${index}.tsx"), { id: "r${index}", render: "ssr" }),`,
    );
  }

  writeFileSync(
    join(dir, "src/routes.ts"),
    [
      'import { defineApp, group, route } from "@pracht/core";',
      "",
      "export const app = defineApp({",
      '  shells: { site: () => import("./shells/site.tsx") },',
      "  routes: [",
      '    group({ shell: "site" }, [',
      ...routes,
      "    ]),",
      "  ],",
      "});",
      "",
    ].join("\n"),
  );
}
