import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { analyzePageModule } from "./page-analysis.ts";
import type { ScannedPage } from "./model.ts";
import { filePathToRoutePath, sortRoutes } from "./route-path.ts";

const PAGE_EXTENSIONS = new Set([".tsx", ".tsrx", ".ts", ".jsx", ".js", ".md", ".mdx"]);
const SHELL_EXTENSIONS = new Set([".tsx", ".tsrx", ".ts", ".jsx", ".js"]);

export function scanPagesDirectory(pagesDir: string): ScannedPage[] {
  const pages: ScannedPage[] = [];
  scanDirectory(pagesDir, pagesDir, pages);

  const appShell = pages.find((page) => page.routePath === "__shell__");
  if (appShell?.hasRevalidateExport) {
    throw new Error(
      `[pracht] Pages app shell ${JSON.stringify(appShell.relativePath)} exports REVALIDATE, ` +
        "but app shells are not ISG routes. Declare the policy on each ISG page instead.",
    );
  }
  return sortRoutes(pages);
}

export function findPagesShellFile(pagesDir: string): string | undefined {
  return scanAllFiles(pagesDir).find(
    (file) => basename(file, extname(file)) === "_app" && SHELL_EXTENSIONS.has(extname(file)),
  );
}

function scanDirectory(dir: string, root: string, pages: ScannedPage[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const absolutePath = join(dir, entry);
    const stat = statSync(absolutePath);

    if (stat.isDirectory()) {
      scanDirectory(absolutePath, root, pages);
      continue;
    }

    const extension = extname(entry);
    if (!PAGE_EXTENSIONS.has(extension)) continue;

    const name = basename(entry, extension);
    // Skip _-prefixed files except _app.
    if (name.startsWith("_") && name !== "_app") continue;

    const relativePath = relative(root, absolutePath);
    const routePath = filePathToRoutePath(relativePath);
    const analysis = analyzePageModule(readFileSync(absolutePath, "utf-8"), relativePath);

    pages.push({
      absolutePath,
      relativePath,
      routePath,
      isIndex: name === "index",
      isCatchAll: routePath.split("/").includes("*"),
      isDynamic: routePath.split("/").some((segment) => segment.startsWith(":")),
      ...analysis,
    });
  }
}

function scanAllFiles(dir: string): string[] {
  const results: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    const absolutePath = join(dir, entry);
    const stat = statSync(absolutePath);
    if (stat.isDirectory()) {
      results.push(...scanAllFiles(absolutePath));
    } else {
      results.push(absolutePath);
    }
  }
  return results;
}
