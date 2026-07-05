import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const SIZE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1024,
  mb: 1024 * 1024,
  gb: 1024 * 1024 * 1024,
};

const SIZE_RE = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/;

/**
 * Parse a size budget value into bytes. Accepts plain numbers (bytes) or
 * size strings like "120kb" / "1mb" (1kb = 1024 bytes).
 */
export function parseSizeToBytes(value: string | number): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(
        `Invalid size ${JSON.stringify(value)}: expected a positive number of bytes.`,
      );
    }
    return Math.floor(value);
  }

  const match = SIZE_RE.exec(value.trim().toLowerCase());
  if (!match) {
    throw new Error(
      `Invalid size ${JSON.stringify(value)}: expected a byte count or a size string like "120kb" or "1mb".`,
    );
  }

  const amount = Number.parseFloat(match[1]);
  const bytes = Math.round(amount * SIZE_UNITS[match[2] ?? "b"]);
  if (bytes <= 0) {
    throw new Error(`Invalid size ${JSON.stringify(value)}: expected a positive size.`);
  }
  return bytes;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}b`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)}kb`;
  return `${(kb / 1024).toFixed(2)}mb`;
}

export interface BundleChunk {
  url: string;
  bytes: number;
  gzipBytes: number;
}

export interface RouteBundle {
  id?: string;
  path: string;
  render: string;
  /** Route-specific chunks (route module + shell, excluding shared entry chunks). */
  chunks: BundleChunk[];
  routeBytes: number;
  routeGzipBytes: number;
  /** Route-specific + shared entry chunks. */
  totalBytes: number;
  totalGzipBytes: number;
}

export interface BundleReport {
  /** Chunks loaded by the client entry on every route. */
  shared: {
    chunks: BundleChunk[];
    bytes: number;
    gzipBytes: number;
  };
  /** Sorted by total gzip size, descending. */
  routes: RouteBundle[];
}

export interface BundleReportRoute {
  id?: string;
  path: string;
  render?: string;
  file: string;
  shellFile?: string;
}

export interface CollectBundleReportOptions {
  routes: BundleReportRoute[];
  jsManifest: Record<string, string[]>;
  clientEntryJs: string[];
  clientDir: string;
}

/** Strip leading `./` and `/` so module paths share one canonical form. */
function normalizeModulePath(path: string): string {
  return path.replace(/^\.?\//, "");
}

// Mirrors the runtime's suffix matching (@pracht/core runtime-manifest) so the
// report resolves the same chunks the server injects for each route.
function buildSuffixIndex(manifest: Record<string, string[]>): Map<string, string> {
  const index = new Map<string, string>();
  for (const key of Object.keys(manifest)) {
    const normalized = normalizeModulePath(key);
    if (!normalized) continue;
    if (!index.has(normalized)) index.set(normalized, key);
    for (let i = normalized.indexOf("/"); i !== -1; i = normalized.indexOf("/", i + 1)) {
      const suffix = normalized.slice(i + 1);
      if (suffix && !index.has(suffix)) index.set(suffix, key);
    }
  }
  return index;
}

function resolveManifestEntries(
  manifest: Record<string, string[]>,
  suffixIndex: Map<string, string>,
  file: string,
): string[] {
  if (file in manifest) return manifest[file];
  const resolved = suffixIndex.get(normalizeModulePath(file));
  return resolved ? manifest[resolved] : [];
}

export function collectBundleReport({
  routes,
  jsManifest,
  clientEntryJs,
  clientDir,
}: CollectBundleReportOptions): BundleReport {
  const suffixIndex = buildSuffixIndex(jsManifest);
  const chunkCache = new Map<string, BundleChunk>();

  function measureChunk(url: string): BundleChunk {
    const cached = chunkCache.get(url);
    if (cached) return cached;

    const filePath = join(clientDir, url.replace(/^\//, ""));
    let bytes = 0;
    let gzipBytes = 0;
    if (existsSync(filePath)) {
      const contents = readFileSync(filePath);
      bytes = contents.byteLength;
      gzipBytes = gzipSync(contents).byteLength;
    }

    const chunk: BundleChunk = { url, bytes, gzipBytes };
    chunkCache.set(url, chunk);
    return chunk;
  }

  const sharedUrls = new Set(clientEntryJs);
  const sharedChunks = clientEntryJs.map(measureChunk);
  const sharedBytes = sumBytes(sharedChunks);
  const sharedGzipBytes = sumGzipBytes(sharedChunks);

  const reportRoutes: RouteBundle[] = routes.map((route) => {
    const urls = new Set<string>();
    if (route.shellFile) {
      for (const url of resolveManifestEntries(jsManifest, suffixIndex, route.shellFile)) {
        urls.add(url);
      }
    }
    for (const url of resolveManifestEntries(jsManifest, suffixIndex, route.file)) {
      urls.add(url);
    }

    const chunks = [...urls]
      .filter((url) => !sharedUrls.has(url))
      .map(measureChunk)
      .sort((left, right) => right.gzipBytes - left.gzipBytes);
    const routeBytes = sumBytes(chunks);
    const routeGzipBytes = sumGzipBytes(chunks);

    return {
      ...(route.id ? { id: route.id } : {}),
      path: route.path,
      render: route.render ?? "ssr",
      chunks,
      routeBytes,
      routeGzipBytes,
      totalBytes: routeBytes + sharedBytes,
      totalGzipBytes: routeGzipBytes + sharedGzipBytes,
    };
  });

  reportRoutes.sort(
    (left, right) =>
      right.totalGzipBytes - left.totalGzipBytes || left.path.localeCompare(right.path),
  );

  return {
    shared: {
      chunks: [...sharedChunks].sort((left, right) => right.gzipBytes - left.gzipBytes),
      bytes: sharedBytes,
      gzipBytes: sharedGzipBytes,
    },
    routes: reportRoutes,
  };
}

function sumBytes(chunks: BundleChunk[]): number {
  return chunks.reduce((total, chunk) => total + chunk.bytes, 0);
}

function sumGzipBytes(chunks: BundleChunk[]): number {
  return chunks.reduce((total, chunk) => total + chunk.gzipBytes, 0);
}

export interface BudgetResult {
  path: string;
  render: string;
  /** The budget value as configured ("120kb", 200000, ...). */
  budget: string | number;
  /** Which budget key matched: the route path or "*". */
  source: string;
  limitBytes: number;
  gzipBytes: number;
  ok: boolean;
}

export interface BudgetEvaluation {
  results: BudgetResult[];
  /** Explicit budget keys that did not match any route. */
  unmatched: string[];
  ok: boolean;
}

export function evaluateBudgets(
  report: BundleReport,
  budgets: Record<string, string | number>,
): BudgetEvaluation {
  const defaultBudget = budgets["*"];
  const explicitKeys = Object.keys(budgets).filter((key) => key !== "*");
  const routePaths = new Set(report.routes.map((route) => route.path));
  const unmatched = explicitKeys.filter((key) => !routePaths.has(key));

  const results: BudgetResult[] = [];
  for (const route of report.routes) {
    const source = route.path in budgets ? route.path : defaultBudget != null ? "*" : null;
    if (source == null) continue;

    const budget = budgets[source];
    const limitBytes = parseSizeToBytes(budget);
    results.push({
      path: route.path,
      render: route.render,
      budget,
      source,
      limitBytes,
      gzipBytes: route.totalGzipBytes,
      ok: route.totalGzipBytes <= limitBytes,
    });
  }

  return {
    results,
    unmatched,
    ok: results.every((result) => result.ok),
  };
}

export interface FormatOptions {
  color?: boolean;
}

export function shouldUseColor(): boolean {
  if (process.env.NO_COLOR) return false;
  return Boolean(process.stdout.isTTY);
}

function paint(text: string, code: string, color: boolean): string {
  return color ? `\u001b[${code}m${text}\u001b[0m` : text;
}

export function formatBundleReport(report: BundleReport, options: FormatOptions = {}): string {
  const color = options.color ?? false;
  const rows: { label: string; raw: string; gzip: string; kind: "chunk" | "total" | "header" }[] =
    [];

  for (const route of report.routes) {
    rows.push({ label: `${route.path} (${route.render})`, raw: "", gzip: "", kind: "header" });
    for (const chunk of route.chunks) {
      rows.push({
        label: `  ${chunk.url}`,
        raw: formatBytes(chunk.bytes),
        gzip: formatBytes(chunk.gzipBytes),
        kind: "chunk",
      });
    }
    rows.push({
      label: "  total (incl. shared)",
      raw: formatBytes(route.totalBytes),
      gzip: formatBytes(route.totalGzipBytes),
      kind: "total",
    });
  }

  rows.push({ label: "shared entry (all routes)", raw: "", gzip: "", kind: "header" });
  for (const chunk of report.shared.chunks) {
    rows.push({
      label: `  ${chunk.url}`,
      raw: formatBytes(chunk.bytes),
      gzip: formatBytes(chunk.gzipBytes),
      kind: "chunk",
    });
  }
  rows.push({
    label: "  total",
    raw: formatBytes(report.shared.bytes),
    gzip: formatBytes(report.shared.gzipBytes),
    kind: "total",
  });

  const labelWidth = Math.max("Route / chunk".length, ...rows.map((row) => row.label.length));
  const gzipWidth = Math.max("Gzip".length, ...rows.map((row) => row.gzip.length));
  const rawWidth = Math.max("Raw".length, ...rows.map((row) => row.raw.length));

  const lines: string[] = [];
  lines.push(
    paint(
      `${"Route / chunk".padEnd(labelWidth)}  ${"Gzip".padStart(gzipWidth)}  ${"Raw".padStart(rawWidth)}`,
      "1",
      color,
    ),
  );

  for (const row of rows) {
    const line = `${row.label.padEnd(labelWidth)}  ${row.gzip.padStart(gzipWidth)}  ${row.raw.padStart(rawWidth)}`;
    if (row.kind === "header") {
      lines.push(paint(line.trimEnd(), "1", color));
    } else if (row.kind === "total") {
      lines.push(paint(line, "36", color));
    } else {
      lines.push(paint(line, "2", color));
    }
  }

  return lines.join("\n");
}

export function formatBudgetResults(
  evaluation: BudgetEvaluation,
  options: FormatOptions = {},
): string {
  const color = options.color ?? false;
  const lines: string[] = [paint("Budgets (gzip client JS)", "1", color)];

  const pathWidth = Math.max(...evaluation.results.map((result) => result.path.length), 0);
  for (const result of evaluation.results) {
    const status = result.ok ? paint("PASS", "32", color) : paint("FAIL", "31", color);
    const comparison = result.ok ? "<=" : ">";
    const suffix = result.source === "*" ? " (*)" : "";
    lines.push(
      `${status}  ${result.path.padEnd(pathWidth)}  ${formatBytes(result.gzipBytes)} ${comparison} ${formatBytes(result.limitBytes)}${suffix}`,
    );
  }

  for (const key of evaluation.unmatched) {
    lines.push(
      paint(`WARN  budget for ${JSON.stringify(key)} does not match any route.`, "33", color),
    );
  }

  return lines.join("\n");
}
