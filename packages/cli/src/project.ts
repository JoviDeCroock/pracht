import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { maskCommentsAndStrings } from "@pracht/capabilities/static";

import { ensureTrailingNewline } from "./utils.js";
import { PROJECT_DEFAULTS } from "./constants.js";

export interface ProjectConfig {
  apiDir: string;
  appFile: string;
  capabilitiesDir: string;
  configFile: string | null;
  hasPrachtPlugin: boolean;
  middlewareDir: string;
  mode: "manifest" | "pages";
  pagesDefaultRender: string;
  pagesDefaultRenderIsStatic: boolean;
  pagesDir: string;
  rawConfig: string;
  root: string;
  routesDir: string;
  serverDir: string;
  shellsDir: string;
}

export function readProjectConfig(root: string): ProjectConfig {
  const configFile = findConfigFile(root);
  const rawConfig = configFile ? readFileSync(configFile, "utf-8") : "";
  const hasPagesDefaultRender = hasConfigProperty(rawConfig, "pagesDefaultRender");
  const resolvedPagesDefaultRender = readQuotedConfigValue(rawConfig, "pagesDefaultRender");
  const config: Record<string, unknown> = {
    ...PROJECT_DEFAULTS,
    configFile,
    hasPrachtPlugin: /\bpracht\s*\(/.test(maskCommentsAndStrings(rawConfig)),
    mode: "manifest" as const,
    rawConfig,
    root,
    pagesDefaultRenderIsStatic: !hasPagesDefaultRender || resolvedPagesDefaultRender !== null,
  };

  for (const key of Object.keys(PROJECT_DEFAULTS)) {
    const value = readQuotedConfigValue(rawConfig, key);
    if (typeof value === "string") {
      config[key] = key === "pagesDefaultRender" ? value : normalizeConfigPath(value);
    }
  }

  config.mode = config.pagesDir ? "pages" : "manifest";
  return config as unknown as ProjectConfig;
}

export function resolveProjectPath(root: string, configPath: string): string {
  return resolve(root, `.${configPath}`);
}

export function resolveScopedFile(root: string, configDir: string, fileName: string): string {
  assertSafePathSegment(fileName.replace(/\.(ts|tsx|js|jsx)$/, ""));
  const baseDir = resolveProjectPath(root, configDir);
  const filePath = resolve(baseDir, fileName);
  assertInsideDirectory(baseDir, filePath);
  return filePath;
}

export function resolveRouteModulePath(
  project: ProjectConfig,
  routePath: string,
  extension: string,
): { absolutePath: string; relativePath: string } {
  const segments = segmentsFromPath(routePath);
  const relativePath =
    segments.length === 0 ? `index${extension}` : `${segments.join("/")}${extension}`;
  const baseDir = resolveProjectPath(project.root, project.routesDir);
  const absolutePath = resolve(baseDir, relativePath);
  assertInsideDirectory(baseDir, absolutePath);
  return { absolutePath, relativePath };
}

export function resolvePagesRouteModulePath(
  project: ProjectConfig,
  routePath: string,
  extension: string,
): { absolutePath: string; relativePath: string } {
  const segments = segmentsFromPath(routePath);
  const relativePath =
    segments.length === 0 ? `index${extension}` : `${segments.join("/")}${extension}`;
  const baseDir = resolveProjectPath(project.root, project.pagesDir);
  const absolutePath = resolve(baseDir, relativePath);
  assertInsideDirectory(baseDir, absolutePath);
  return { absolutePath, relativePath };
}

export function resolveApiModulePath(
  project: ProjectConfig,
  endpointPath: string,
): { absolutePath: string; relativePath: string } {
  const segments = segmentsFromPath(endpointPath);
  const relativePath = segments.length === 0 ? "index.ts" : `${segments.join("/")}.ts`;
  const baseDir = resolveProjectPath(project.root, project.apiDir);
  const absolutePath = resolve(baseDir, relativePath);
  assertInsideDirectory(baseDir, absolutePath);
  return { absolutePath, relativePath };
}

export function displayPath(root: string, filePath: string): string {
  return (relative(root, filePath) || ".").replace(/\\/g, "/");
}

export function writeGeneratedFile(filePath: string, source: string): void {
  if (existsSync(filePath)) {
    throw new Error(`Refusing to overwrite existing file ${filePath}.`);
  }

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, ensureTrailingNewline(source), "utf-8");
}

export function assertFileExists(filePath: string, message: string): void {
  if (!existsSync(filePath)) {
    throw new Error(message);
  }
}

export function listFilesRecursively(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursively(fullPath));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

export function hasPagesAppShell(filePath: string): boolean {
  return /^_app\.(ts|tsx|tsrx|js|jsx)$/.test(basename(filePath));
}

function findConfigFile(root: string): string | null {
  for (const name of [
    "vite.config.ts",
    "vite.config.mts",
    "vite.config.js",
    "vite.config.mjs",
    "vite.config.cjs",
    "vite.config.cts",
  ]) {
    const file = resolve(root, name);
    if (existsSync(file)) return file;
  }
  return null;
}

function readQuotedConfigValue(source: string, key: string): string | null {
  if (!source) return null;
  const masked = maskCommentsAndStrings(source);
  const properties = [...masked.matchAll(new RegExp(`\\b${key}\\s*:`, "g"))];
  if (properties.length !== 1) return null;
  const property = properties[0];

  const valueStart = (property.index ?? 0) + property[0].length;
  const direct = readQuotedValueAt(source, valueStart);
  if (direct !== null) return direct;

  const identifier = /^\s*([A-Za-z_$][\w$]*)\b/.exec(source.slice(valueStart))?.[1];
  if (!identifier) return null;
  const declarations = [...masked.matchAll(new RegExp(`\\bconst\\s+${identifier}\\s*=`, "g"))];
  if (declarations.length !== 1) return null;
  const declaration = declarations[0];
  return readQuotedValueAt(source, (declaration.index ?? 0) + declaration[0].length);
}

function hasConfigProperty(source: string, key: string): boolean {
  return new RegExp(`\\b${key}\\s*:`).test(maskCommentsAndStrings(source));
}

function readQuotedValueAt(source: string, start: number): string | null {
  const match = /^\s*(["'`])([^"'`]+)\1/.exec(source.slice(start));
  return match?.[2] ?? null;
}

function normalizeConfigPath(value: string): string {
  if (!value) return value;
  return value.startsWith("/") ? value : `/${value}`;
}

function segmentsFromPath(path: string): string[] {
  return path
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      assertSafePathSegment(segment);
      if (segment.startsWith(":")) {
        const name = segment.endsWith("*") ? segment.slice(1, -1) : segment.slice(1);
        assertSafePathSegment(name);
        return segment.endsWith("*") ? `[...${name || "slug"}]` : `[${name}]`;
      }
      if (segment === "*") return "[...slug]";
      return segment;
    });
}

function assertSafePathSegment(segment: string): void {
  if (
    !segment ||
    segment === "." ||
    segment === ".." ||
    segment.includes("/") ||
    segment.includes("\\") ||
    segment.includes("\0")
  ) {
    throw new Error(`Unsafe path segment: ${JSON.stringify(segment)}.`);
  }
}

function assertInsideDirectory(baseDir: string, filePath: string): void {
  const relativePath = relative(baseDir, filePath);
  if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) {
    return;
  }
  throw new Error(`Refusing to write outside ${baseDir}.`);
}
