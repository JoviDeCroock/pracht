import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export type BuildOutputLogger = (message: string) => void;

export interface PrerenderedPageOutput {
  path: string;
  html: string;
}

interface StaticOutputOptions {
  clientDir: string;
  root: string;
  log: BuildOutputLogger;
}

export function writePrerenderedPages(
  pages: readonly PrerenderedPageOutput[],
  options: StaticOutputOptions,
): void {
  if (pages.length === 0) return;

  options.log(`\n  Prerendering ${pages.length} SSG/ISG route(s)...\n`);
  for (const page of pages) {
    const filePath = resolvePrerenderOutputPath(options.clientDir, page.path);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, page.html, "utf-8");
    options.log(`    ${page.path} → ${filePath.replace(options.root + "/", "")}`);
  }
}

export function writeGeneratedLlmsTxt(content: string, options: StaticOutputOptions): void {
  // Vite copies public/ before this runs. Warn instead of silently replacing a
  // file the application author expected to control.
  if (existsSync(resolve(options.root, "public/llms.txt"))) {
    options.log(
      "\n  Warning: public/llms.txt is overwritten by the generated llms.txt.\n" +
        "  Remove it, or disable the plugin's `llmsTxt` option to hand-author the file.",
    );
  }
  writeFileSync(resolve(options.clientDir, "llms.txt"), content, "utf-8");
  options.log("\n  llms.txt → dist/client/llms.txt\n");
}

export function writeOpenApiBuildArtifacts(
  generated: unknown,
  options: StaticOutputOptions,
): string[] {
  const result =
    generated && typeof generated === "object"
      ? (generated as { artifacts?: unknown; warnings?: unknown })
      : {};
  const artifacts = Array.isArray(result.artifacts) ? result.artifacts : [];
  const generatedStaticRoutes: string[] = [];
  const seenOutputPaths = new Set<string>();

  for (const artifact of artifacts) {
    if (
      !artifact ||
      typeof artifact !== "object" ||
      typeof (artifact as { outputPath?: unknown }).outputPath !== "string" ||
      typeof (artifact as { content?: unknown }).content !== "string"
    ) {
      throw new Error("OpenAPI generator returned an invalid build artifact.");
    }
    const typedArtifact = artifact as { outputPath: string; content: string; path?: unknown };
    const filePath = resolveGeneratedArtifactOutputPath(
      options.clientDir,
      typedArtifact.outputPath,
    );
    if (seenOutputPaths.has(filePath)) {
      throw new Error(
        `OpenAPI generator returned duplicate output path ${JSON.stringify(typedArtifact.outputPath)}.`,
      );
    }
    seenOutputPaths.add(filePath);

    if (
      typeof typedArtifact.path === "string" &&
      typedArtifact.path.startsWith("/") &&
      typedArtifact.outputPath ===
        (typedArtifact.path === "/" ? "index.html" : `${typedArtifact.path.slice(1)}/index.html`)
    ) {
      generatedStaticRoutes.push(typedArtifact.path);
    }
    if (existsSync(filePath)) {
      options.log(
        `\n  Warning: OpenAPI artifact ${typedArtifact.outputPath} replaces an existing public/build file.\n`,
      );
    }
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, typedArtifact.content, "utf-8");
    options.log(`\n  OpenAPI → dist/client/${typedArtifact.outputPath}\n`);
  }

  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  for (const warning of warnings) {
    const typedWarning =
      warning && typeof warning === "object"
        ? (warning as { message?: unknown; method?: unknown; path?: unknown })
        : {};
    const method = typeof typedWarning.method === "string" ? `${typedWarning.method} ` : "";
    const path = typeof typedWarning.path === "string" ? typedWarning.path : "unknown route";
    const message =
      typeof typedWarning.message === "string" ? typedWarning.message : String(warning);
    options.log(`  OpenAPI warning: ${method}${path}: ${message}\n`);
  }

  return generatedStaticRoutes;
}

export function resolvePrerenderOutputPath(clientDir: string, routePath: string): string {
  if (routePath.includes("\0")) {
    throw new Error(`Refusing to write prerendered route "${routePath}" with a NUL byte.`);
  }

  const root = resolve(clientDir);
  const filePath =
    routePath === "/" ? resolve(root, "index.html") : resolve(root, `.${routePath}`, "index.html");
  assertPathInside(
    root,
    filePath,
    () => `Refusing to write prerendered route "${routePath}" outside dist/client (${filePath}).`,
  );
  return filePath;
}

export function resolveGeneratedArtifactOutputPath(clientDir: string, outputPath: string): string {
  if (
    !outputPath ||
    outputPath.includes("\0") ||
    outputPath.includes("\\") ||
    isAbsolute(outputPath)
  ) {
    throw new Error(
      `Refusing to write generated artifact with unsafe output path ${JSON.stringify(outputPath)}.`,
    );
  }

  const root = resolve(clientDir);
  const filePath = resolve(root, outputPath);
  assertPathInside(
    root,
    filePath,
    () => `Refusing to write generated artifact ${JSON.stringify(outputPath)} outside dist/client.`,
  );
  return filePath;
}

function assertPathInside(root: string, filePath: string, errorMessage: () => string): void {
  const relativePath = relative(root, filePath);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(errorMessage());
  }
}
