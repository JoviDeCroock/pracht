import { quote } from "../utils.js";
import { dynamicParamNames } from "./paths.js";

export interface RouteModuleParts {
  includeErrorBoundary: boolean;
  includeLoader: boolean;
  includeStaticPaths: boolean;
  routePath: string;
  title: string;
}

export function buildManifestRouteModuleSource(opts: RouteModuleParts): string {
  const sections = buildRouteModuleSections(opts);

  // Insert head() before the Component export (after loader/getStaticPaths)
  const componentIdx = sections.findIndex((s) => s.startsWith("export function Component"));
  const insertAt = componentIdx === -1 ? sections.length : componentIdx;
  sections.splice(
    insertAt,
    0,
    "export function head() {",
    `  return { title: ${quote(opts.title)} };`,
    "}",
    "",
  );

  return `${sections.join("\n")}\n`;
}

export function buildPagesRouteModuleSource(
  opts: RouteModuleParts & { render: string; revalidateSeconds?: number },
): string {
  const sections = buildRouteModuleSections(opts);

  // Insert RENDER_MODE before the first exported declaration (after imports)
  const firstExportIdx = sections.findIndex((s) => s.startsWith("export"));
  const insertAt = firstExportIdx === -1 ? sections.length : firstExportIdx;
  const policyExports = [`export const RENDER_MODE = ${quote(opts.render)};`];
  if (opts.revalidateSeconds !== undefined) {
    policyExports.push(`export const REVALIDATE = ${opts.revalidateSeconds};`);
  }
  sections.splice(insertAt, 0, ...policyExports, "");

  return `${sections.join("\n")}\n`;
}

/**
 * A Playwright smoke test emitted alongside a generated route: the route
 * serves successfully and renders its heading. Output-level proof the route
 * exists, cheap enough to run on every change.
 */
export function buildRouteSmokeTestSource({
  routePath,
  title,
}: {
  routePath: string;
  title: string;
}): string {
  const visitPath = exampleVisitPath(routePath);
  return [
    'import { expect, test } from "@playwright/test";',
    "",
    `test(${quote(`renders ${routePath}`)}, async ({ page }) => {`,
    `  const response = await page.goto(${quote(visitPath)});`,
    '  expect(response?.status(), "route should serve successfully").toBeLessThan(400);',
    `  await expect(page.locator("h1").first()).toHaveText(${quote(title)});`,
    "});",
    "",
  ].join("\n");
}

/** Substitute example values for dynamic segments, matching the getStaticPaths stub. */
function exampleVisitPath(routePath: string): string {
  if (routePath === "/") return "/";
  const segments = routePath
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      if (segment === "*") return "example-slug";
      if (segment.startsWith(":")) {
        const name = segment.endsWith("*") ? segment.slice(1, -1) : segment.slice(1);
        return `example-${name || "slug"}`;
      }
      return segment;
    });
  return `/${segments.join("/")}`;
}

function buildRouteModuleSections(opts: RouteModuleParts): string[] {
  const { includeErrorBoundary, includeLoader, includeStaticPaths, routePath, title } = opts;
  const params = dynamicParamNames(routePath);
  const imports: string[] = [];
  const sections: string[] = [];

  if (includeLoader) {
    imports.push("LoaderArgs", "RouteComponentProps");
  }
  if (includeErrorBoundary) {
    imports.push("ErrorBoundaryProps");
  }

  if (imports.length > 0) {
    sections.push(`import type { ${imports.join(", ")} } from "@pracht/core";`);
    sections.push("");
  }

  if (includeLoader) {
    sections.push(
      "export async function loader(_args: LoaderArgs) {",
      `  return { message: ${quote(`Welcome to ${title}.`)} };`,
      "}",
      "",
    );
  }

  if (includeStaticPaths) {
    sections.push(
      "export function getStaticPaths() {",
      `  return [${buildStaticPathsStub(params)}];`,
      "}",
      "",
    );
  }

  if (includeLoader) {
    sections.push(
      "export function Component({ data }: RouteComponentProps<typeof loader>) {",
      "  return (",
      "    <section>",
      `      <h1>${escapeJsxText(title)}</h1>`,
      "      <p>{data.message}</p>",
      "    </section>",
      "  );",
      "}",
    );
  } else {
    sections.push(
      "export function Component() {",
      "  return (",
      "    <section>",
      `      <h1>${escapeJsxText(title)}</h1>`,
      "    </section>",
      "  );",
      "}",
    );
  }

  if (includeErrorBoundary) {
    sections.push(
      "",
      "export function ErrorBoundary({ error }: ErrorBoundaryProps) {",
      "  return <p>{error.message}</p>;",
      "}",
    );
  }

  return sections;
}

function buildStaticPathsStub(params: string[]): string {
  if (params.length === 0) {
    return "{}";
  }

  return `{ ${params.map((name) => `${name}: ${quote(`example-${name}`)}`).join(", ")} }`;
}

function escapeJsxText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
