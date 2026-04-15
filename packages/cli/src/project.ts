import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";

import { ensureTrailingNewline } from "./utils.js";
import { PROJECT_DEFAULTS } from "./constants.js";

export interface ProjectConfig {
  apiDir: string;
  appFile: string;
  configFile: string | null;
  hasPrachtPlugin: boolean;
  middlewareDir: string;
  mode: "manifest" | "pages";
  pagesDefaultRender: string;
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
  const config: Record<string, unknown> = {
    ...PROJECT_DEFAULTS,
    configFile,
    hasPrachtPlugin: /\bpracht\s*\(/.test(rawConfig),
    mode: "manifest" as const,
    rawConfig,
    root,
  };

  for (const key of Object.keys(PROJECT_DEFAULTS)) {
    const value = readQuotedConfigValue(rawConfig, key);
    if (typeof value === "string") {
      config[key] = normalizeConfigPath(value);
    }
  }

  config.mode = config.pagesDir ? "pages" : "manifest";
  return config as unknown as ProjectConfig;
}

export function resolveProjectPath(root: string, configPath: string): string {
  return resolve(root, `.${configPath}`);
}

export function resolveScopedFile(root: string, configDir: string, fileName: string): string {
  return resolve(resolveProjectPath(root, configDir), fileName);
}

export function resolveRouteModulePath(
  project: ProjectConfig,
  routePath: string,
  extension: string,
): { absolutePath: string; relativePath: string } {
  const segments = segmentsFromPath(routePath);
  const relativePath =
    segments.length === 0 ? `index${extension}` : `${segments.join("/")}${extension}`;
  const absolutePath = resolve(resolveProjectPath(project.root, project.routesDir), relativePath);
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
  const absolutePath = resolve(resolveProjectPath(project.root, project.pagesDir), relativePath);
  return { absolutePath, relativePath };
}

export function resolveApiModulePath(
  project: ProjectConfig,
  endpointPath: string,
): { absolutePath: string; relativePath: string } {
  const segments = segmentsFromPath(endpointPath);
  const relativePath = segments.length === 0 ? "index.ts" : `${segments.join("/")}.ts`;
  const absolutePath = resolve(resolveProjectPath(project.root, project.apiDir), relativePath);
  return { absolutePath, relativePath };
}

export function displayPath(root: string, filePath: string): string {
  return relative(root, filePath) || ".";
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
  return /^_app\.(ts|tsx|js|jsx)$/.test(basename(filePath));
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
  const pattern = new RegExp(`${key}\\s*:\\s*(["'\\\`])([^"'\\\`]+)\\1`);
  const match = source.match(pattern);
  return match ? match[2] : null;
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
      if (segment.startsWith(":")) return `[${segment.slice(1)}]`;
      if (segment === "*") return "[...slug]";
      return segment;
    });
}
