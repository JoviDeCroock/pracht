import { quote } from "../utils.js";
import { dynamicParamNames, titleCase } from "./generate-paths.js";

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

export function buildPagesRouteModuleSource(opts: RouteModuleParts & { render: string }): string {
  const sections = buildRouteModuleSections(opts);

  // Insert RENDER_MODE before the first exported declaration (after imports)
  const firstExportIdx = sections.findIndex((s) => s.startsWith("export"));
  const insertAt = firstExportIdx === -1 ? sections.length : firstExportIdx;
  sections.splice(insertAt, 0, `export const RENDER_MODE = ${quote(opts.render)};`, "");

  return `${sections.join("\n")}\n`;
}

export function buildShellModuleSource(name: string): string {
  const title = titleCase(name);
  return [
    'import type { ShellProps } from "@pracht/core";',
    "",
    "export function Shell({ children }: ShellProps) {",
    "  return (",
    `    <div class=${quote(`${name}-shell`)}>`,
    "      <main>{children}</main>",
    "    </div>",
    "  );",
    "}",
    "",
    "export function head() {",
    `  return { title: ${quote(title)} };`,
    "}",
    "",
  ].join("\n");
}

export function buildMiddlewareModuleSource(): string {
  return [
    'import type { MiddlewareFn } from "@pracht/core";',
    "",
    "export const middleware: MiddlewareFn = async (_args) => {",
    "  return;",
    "};",
    "",
  ].join("\n");
}

export function buildApiRouteSource({
  endpointPath,
  methods,
}: {
  endpointPath: string;
  methods: string[];
}): string {
  const methodLines = methods.flatMap((method, index) => {
    const lines = buildApiMethodSource(method, methods, endpointPath);
    if (index === methods.length - 1) return lines;
    return [...lines, ""];
  });

  return ['import type { BaseRouteArgs } from "@pracht/core";', "", ...methodLines, ""].join("\n");
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

function buildApiMethodSource(method: string, methods: string[], endpointPath: string): string[] {
  if (method === "DELETE" || method === "HEAD") {
    return [
      `export function ${method}(_args: BaseRouteArgs) {`,
      "  return new Response(null, { status: 204 });",
      "}",
    ];
  }

  if (method === "OPTIONS") {
    return [
      `export function ${method}(_args: BaseRouteArgs) {`,
      "  return new Response(null, {",
      `    headers: { allow: ${quote(methods.join(", "))} },`,
      "    status: 204,",
      "  });",
      "}",
    ];
  }

  if (method === "GET") {
    return [
      `export function ${method}(_args: BaseRouteArgs) {`,
      `  return Response.json({ endpoint: ${quote(`/api${endpointPath}`)}, ok: true });`,
      "}",
    ];
  }

  const status = method === "POST" ? 201 : 200;
  return [
    `export async function ${method}({ request }: BaseRouteArgs) {`,
    "  const body = await request.json();",
    `  return Response.json({ body, ok: true }, { status: ${status} });`,
    "}",
  ];
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
