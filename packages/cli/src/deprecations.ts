// Machine-readable deprecations.
//
// Every published `@pracht/*` package may ship a `deprecations.json` alongside
// its `dist/`, pointed at by the `pracht.deprecations` field in its
// `package.json`. Each record describes one renamed, changed, or removed API:
// the versions it spans, how to find it in app source, and (optionally) a
// codemod that rewrites it.
//
// The upgrade path then stops being prose a human or an agent has to
// re-derive from CHANGELOG diffs. `pracht upgrade` reads the manifests of the
// packages that are actually installed, greps the app for the APIs they name,
// and reports real call sites — which is also why the manifests live in the
// npm tarball rather than in this CLI: a package's deprecations ship and
// version with the package that owns them, including third-party ones.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { maskCommentsAndStrings } from "@pracht/capabilities/static";

import { displayPath } from "./project.js";

export const DEPRECATION_MANIFEST_VERSION = 1;

/** Manifest path relative to the owning package root when the field is absent. */
const DEFAULT_MANIFEST_FILE = "deprecations.json";

/** Where a record looks for usage when it does not narrow `include` itself. */
const DEFAULT_INCLUDE = [
  "src/**/*.{ts,tsx,js,jsx,mts,mjs,cts,cjs}",
  "*.config.{ts,tsx,js,jsx,mts,mjs,cts,cjs}",
];

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".netlify",
  ".output",
  ".pracht",
  ".turbo",
  ".vercel",
  ".vite",
  ".wrangler",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);

/** Skip anything implausible as hand-written source; keeps a bad glob cheap. */
const MAX_SCANNED_FILE_BYTES = 1_000_000;

export interface DeprecationDetector {
  /** Glob patterns, relative to the app root, POSIX separators. */
  include: string[];
  /** Regular expression source matched against each file. */
  pattern: string;
  /** Extra regex flags; `g` is always applied. */
  flags?: string;
  /**
   * Match inside string and comment tokens too. Off by default so a mention in
   * a comment, or the name of an unrelated route, is not reported as usage.
   */
  matchStrings?: boolean;
}

export interface DeprecationRecord {
  /** Stable identifier, `<package-short>.<slug>`. Cited by reports and CI. */
  id: string;
  title: string;
  /** Version of the owning package that deprecated the API. */
  since: string;
  /** Version that removed it. Absent means removal is not scheduled yet. */
  removedIn?: string;
  replacement?: string;
  detail?: string;
  docs?: string;
  detect?: DeprecationDetector;
  /** Path, relative to the owning package root, of a codemod module. */
  codemod?: string;
}

export interface DeprecationManifest {
  version: number;
  package: string;
  deprecations: DeprecationRecord[];
}

/**
 * A codemod is a plain text transform so any package can ship one without
 * pulling an AST toolchain into its tarball. Returning `null` means "nothing
 * to change here", which is not an error — detection is per file, and a
 * pattern can match a line a rename does not apply to.
 */
export interface DeprecationCodemod {
  id?: string;
  transform(source: string, context: { path: string }): string | null;
}

export interface InstalledPackage {
  name: string;
  /** Range declared in the app's `package.json`, if it is a direct dependency. */
  declared: string | null;
  /** Resolved version on disk, or `null` when the package is not installed. */
  version: string | null;
  directory: string | null;
  manifest: DeprecationManifest | null;
}

export type DeprecationSeverity = "error" | "warn";

export interface DeprecationOccurrence {
  file: string;
  line: number;
  text: string;
}

export interface DeprecationFinding {
  id: string;
  package: string;
  title: string;
  severity: DeprecationSeverity;
  since: string;
  removedIn: string | null;
  installedVersion: string | null;
  replacement: string | null;
  detail: string | null;
  docs: string | null;
  /** Absolute path of the codemod module, when the owning package ships one. */
  codemod: string | null;
  occurrences: DeprecationOccurrence[];
}

export interface UpgradeReport {
  root: string;
  packageManager: "pnpm" | "npm" | "yarn" | "bun";
  /** Suggested command to move the whole family forward; never run for you. */
  upgradeCommand: string | null;
  packages: InstalledPackage[];
  findings: DeprecationFinding[];
  /** Non-fatal problems: unreadable or malformed manifests, bad globs. */
  warnings: string[];
  /** True when nothing is using an API that the installed versions removed. */
  ok: boolean;
}

export interface CodemodResult {
  changedFiles: string[];
  appliedIds: string[];
  /** Findings that have no codemod, or whose codemod failed to load. */
  skipped: { id: string; reason: string }[];
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

export function parseVersion(value: string): ParsedVersion | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    value.trim(),
  );
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

/**
 * `null` when either side is not a plain semver version — callers treat an
 * incomparable pair as "unknown" rather than guessing an ordering.
 */
export function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  if (left.patch !== right.patch) return left.patch - right.patch;
  if (left.prerelease === right.prerelease) return 0;
  // A prerelease sorts before its release: 1.0.0-rc.1 < 1.0.0.
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
}

// ---------------------------------------------------------------------------
// Globs
// ---------------------------------------------------------------------------

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Supports `**`, `*`, `?`, and `{a,b}` against POSIX-separated paths. */
export function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*") {
      if (glob[index + 1] === "*") {
        index += 1;
        if (glob[index + 1] === "/") {
          index += 1;
          // `a/**/b` has to match `a/b` too, so the separator is part of the
          // repeated group rather than a literal between them.
          source += "(?:[^/]*/)*";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    if (char === "{") {
      const end = glob.indexOf("}", index);
      if (end === -1) {
        source += "\\{";
        continue;
      }
      const alternatives = glob
        .slice(index + 1, end)
        .split(",")
        .map((entry) => escapeRegExp(entry));
      source += `(?:${alternatives.join("|")})`;
      index = end;
      continue;
    }
    source += escapeRegExp(char);
  }
  return new RegExp(`^${source}$`);
}

// ---------------------------------------------------------------------------
// Manifests
// ---------------------------------------------------------------------------

function readJsonFile(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Validates a manifest that came from another package's tarball. Anything
 * malformed is reported and dropped: a bad record in a dependency must not
 * stop the command from reporting the good ones.
 */
export function parseDeprecationManifest(
  value: unknown,
  packageName: string,
  warnings: string[],
): DeprecationManifest | null {
  if (!isRecord(value)) {
    warnings.push(`${packageName}: deprecations manifest is not an object.`);
    return null;
  }
  if (value.version !== DEPRECATION_MANIFEST_VERSION) {
    warnings.push(
      `${packageName}: deprecations manifest version ${String(value.version)} is not supported ` +
        `(this CLI understands version ${DEPRECATION_MANIFEST_VERSION}).`,
    );
    return null;
  }
  if (!Array.isArray(value.deprecations)) {
    warnings.push(`${packageName}: deprecations manifest has no "deprecations" array.`);
    return null;
  }

  const records: DeprecationRecord[] = [];
  for (const entry of value.deprecations) {
    if (!isRecord(entry)) {
      warnings.push(`${packageName}: skipped a deprecation entry that is not an object.`);
      continue;
    }
    const id = optionalString(entry.id);
    const title = optionalString(entry.title);
    const since = optionalString(entry.since);
    if (!id || !title || !since) {
      warnings.push(
        `${packageName}: skipped a deprecation entry missing "id", "title", or "since".`,
      );
      continue;
    }

    let detect: DeprecationDetector | undefined;
    if (entry.detect !== undefined) {
      if (!isRecord(entry.detect) || typeof entry.detect.pattern !== "string") {
        warnings.push(`${packageName}: ${id} has a "detect" without a string "pattern".`);
        continue;
      }
      const include = Array.isArray(entry.detect.include)
        ? entry.detect.include.filter((glob): glob is string => typeof glob === "string")
        : DEFAULT_INCLUDE;
      try {
        // Compiled eagerly so a bad pattern is a manifest warning rather than
        // a crash halfway through the scan.
        new RegExp(entry.detect.pattern, entry.detect.flags ? String(entry.detect.flags) : "");
      } catch (error) {
        warnings.push(
          `${packageName}: ${id} has an invalid "detect.pattern" (${(error as Error).message}).`,
        );
        continue;
      }
      detect = {
        include: include.length > 0 ? include : DEFAULT_INCLUDE,
        pattern: entry.detect.pattern,
        ...(typeof entry.detect.flags === "string" ? { flags: entry.detect.flags } : {}),
        ...(entry.detect.matchStrings === true ? { matchStrings: true } : {}),
      };
    }

    records.push({
      id,
      title,
      since,
      ...(optionalString(entry.removedIn) ? { removedIn: optionalString(entry.removedIn)! } : {}),
      ...(optionalString(entry.replacement)
        ? { replacement: optionalString(entry.replacement)! }
        : {}),
      ...(optionalString(entry.detail) ? { detail: optionalString(entry.detail)! } : {}),
      ...(optionalString(entry.docs) ? { docs: optionalString(entry.docs)! } : {}),
      ...(detect ? { detect } : {}),
      ...(optionalString(entry.codemod) ? { codemod: optionalString(entry.codemod)! } : {}),
    });
  }

  return { version: DEPRECATION_MANIFEST_VERSION, package: packageName, deprecations: records };
}

function loadManifestForPackage(
  packageDirectory: string,
  packageJson: Record<string, unknown>,
  packageName: string,
  warnings: string[],
): DeprecationManifest | null {
  const pracht = isRecord(packageJson.pracht) ? packageJson.pracht : null;
  const declared = pracht ? optionalString(pracht.deprecations) : undefined;
  // An undeclared but conventionally named file still counts: it keeps the
  // field optional for first-party packages without making the contract
  // implicit for third-party ones, which should declare it.
  const manifestPath = resolve(packageDirectory, declared ?? DEFAULT_MANIFEST_FILE);
  if (!existsSync(manifestPath)) {
    if (declared) {
      warnings.push(`${packageName}: pracht.deprecations points at a missing file (${declared}).`);
    }
    return null;
  }
  try {
    return parseDeprecationManifest(readJsonFile(manifestPath), packageName, warnings);
  } catch (error) {
    warnings.push(
      `${packageName}: could not read deprecations manifest (${(error as Error).message}).`,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Installed package inventory
// ---------------------------------------------------------------------------

function readPackageJson(filePath: string): Record<string, unknown> | null {
  try {
    const parsed = readJsonFile(filePath);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Walks up from the app root looking for `node_modules/<name>`. Resolving
 * through `require` would be stricter but fails on packages that do not export
 * `./package.json`, which is most of them.
 */
function findInstalledPackage(root: string, name: string): string | null {
  let directory = resolve(root);
  for (;;) {
    const candidate = join(directory, "node_modules", ...name.split("/"));
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function collectPrachtDependencyNames(appPackageJson: Record<string, unknown> | null): Set<string> {
  const names = new Set<string>();
  if (!appPackageJson) return names;
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    const section = appPackageJson[field];
    if (!isRecord(section)) continue;
    for (const name of Object.keys(section)) {
      if (name.startsWith("@pracht/")) names.add(name);
    }
  }
  return names;
}

/** Hoisted transitive pracht packages carry deprecations that affect app code too. */
function collectInstalledPrachtNames(root: string): Set<string> {
  const names = new Set<string>();
  let directory = resolve(root);
  for (;;) {
    const scope = join(directory, "node_modules", "@pracht");
    if (existsSync(scope)) {
      try {
        for (const entry of listDirectories(scope)) names.add(`@pracht/${entry}`);
      } catch {
        // An unreadable node_modules is the package manager's problem, not ours.
      }
    }
    const parent = dirname(directory);
    if (parent === directory) return names;
    directory = parent;
  }
}

function listDirectories(directory: string): string[] {
  // pnpm links workspace and store packages in, so a scope entry is as likely
  // to be a symlink as a real directory.
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name);
}

export function readInstalledPackages(root: string, warnings: string[]): InstalledPackage[] {
  const appPackageJson = readPackageJson(resolve(root, "package.json"));
  const declaredRanges = new Map<string, string>();
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    const section = appPackageJson?.[field];
    if (!isRecord(section)) continue;
    for (const [name, range] of Object.entries(section)) {
      if (name.startsWith("@pracht/") && typeof range === "string" && !declaredRanges.has(name)) {
        declaredRanges.set(name, range);
      }
    }
  }

  const names = new Set<string>([
    ...collectPrachtDependencyNames(appPackageJson),
    ...collectInstalledPrachtNames(root),
  ]);

  const packages: InstalledPackage[] = [];
  for (const name of [...names].sort()) {
    const directory = findInstalledPackage(root, name);
    const packageJson = directory ? readPackageJson(join(directory, "package.json")) : null;
    const version = typeof packageJson?.version === "string" ? packageJson.version : null;
    packages.push({
      name,
      declared: declaredRanges.get(name) ?? null,
      version,
      directory,
      manifest:
        directory && packageJson
          ? loadManifestForPackage(directory, packageJson, name, warnings)
          : null,
    });
  }
  return packages;
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

interface CompiledDetector {
  record: DeprecationRecord;
  owner: InstalledPackage;
  includes: RegExp[];
  pattern: RegExp;
  matchStrings: boolean;
}

/**
 * A record only applies when the installed version actually contains it. The
 * `error` severity is reserved for APIs the installed version has already
 * removed — code calling those is broken right now, not merely dated.
 */
function severityFor(
  record: DeprecationRecord,
  installedVersion: string | null,
): {
  applies: boolean;
  severity: DeprecationSeverity;
} {
  if (!installedVersion) return { applies: true, severity: "warn" };
  const sinceOrder = compareVersions(installedVersion, record.since);
  if (sinceOrder !== null && sinceOrder < 0) return { applies: false, severity: "warn" };
  if (!record.removedIn) return { applies: true, severity: "warn" };
  const removedOrder = compareVersions(installedVersion, record.removedIn);
  if (removedOrder === null) return { applies: true, severity: "warn" };
  return { applies: true, severity: removedOrder >= 0 ? "error" : "warn" };
}

function collectScannableFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    let entries: { name: string; isDirectory(): boolean }[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        walk(fullPath);
        continue;
      }
      files.push(fullPath);
    }
  };
  walk(resolve(root));
  return files;
}

function scanFile(
  root: string,
  filePath: string,
  detectors: CompiledDetector[],
  results: Map<string, DeprecationOccurrence[]>,
): void {
  let source: string;
  try {
    if (statSync(filePath).size > MAX_SCANNED_FILE_BYTES) return;
    source = readFileSync(filePath, "utf-8");
  } catch {
    return;
  }

  const relativePath = displayPath(root, filePath);
  let masked: string | null = null;
  const lineStarts = buildLineStarts(source);

  for (const detector of detectors) {
    if (!detector.includes.some((include) => include.test(relativePath))) continue;
    // Masking preserves offsets, so line numbers stay correct either way.
    const haystack = detector.matchStrings ? source : (masked ??= maskCommentsAndStrings(source));
    detector.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = detector.pattern.exec(haystack)) !== null) {
      const line = lineNumberAt(lineStarts, match.index);
      const occurrences = results.get(detector.record.id) ?? [];
      occurrences.push({
        file: relativePath,
        line,
        text: sourceLine(source, lineStarts, line),
      });
      results.set(detector.record.id, occurrences);
      // A zero-width pattern would otherwise spin here forever.
      if (match[0].length === 0) detector.pattern.lastIndex += 1;
    }
  }
}

function buildLineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function lineNumberAt(lineStarts: number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (lineStarts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

function sourceLine(source: string, lineStarts: number[], line: number): string {
  const start = lineStarts[line - 1] ?? 0;
  const end = lineStarts[line] ?? source.length + 1;
  return source.slice(start, end - 1).trim();
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function detectPackageManager(root: string): UpgradeReport["packageManager"] {
  if (existsSync(resolve(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(resolve(root, "yarn.lock"))) return "yarn";
  if (existsSync(resolve(root, "bun.lock")) || existsSync(resolve(root, "bun.lockb"))) return "bun";
  return "npm";
}

function upgradeCommandFor(
  packageManager: UpgradeReport["packageManager"],
  packages: InstalledPackage[],
): string | null {
  // Only direct dependencies: telling someone to install a hoisted transitive
  // package would add a dependency they never had.
  const names = packages.filter((entry) => entry.declared !== null).map((entry) => entry.name);
  if (names.length === 0) return null;
  const specs = names.map((name) => `${name}@latest`).join(" ");
  switch (packageManager) {
    case "pnpm":
      return `pnpm up ${specs}`;
    case "yarn":
      return `yarn up ${specs}`;
    case "bun":
      return `bun update ${names.join(" ")}`;
    default:
      return `npm install ${specs}`;
  }
}

export function buildUpgradeReport(root: string): UpgradeReport {
  const warnings: string[] = [];
  const packages = readInstalledPackages(root, warnings);

  const detectors: CompiledDetector[] = [];
  const applicable: {
    record: DeprecationRecord;
    owner: InstalledPackage;
    severity: DeprecationSeverity;
  }[] = [];
  const seenIds = new Set<string>();

  for (const owner of packages) {
    for (const record of owner.manifest?.deprecations ?? []) {
      const { applies, severity } = severityFor(record, owner.version);
      if (!applies) continue;
      if (seenIds.has(record.id)) {
        warnings.push(`${owner.name}: duplicate deprecation id "${record.id}" was ignored.`);
        continue;
      }
      seenIds.add(record.id);
      applicable.push({ record, owner, severity });
      if (!record.detect) continue;
      detectors.push({
        record,
        owner,
        includes: record.detect.include.map((glob) => globToRegExp(glob)),
        pattern: new RegExp(
          record.detect.pattern,
          record.detect.flags?.includes("g")
            ? record.detect.flags
            : `${record.detect.flags ?? ""}g`,
        ),
        matchStrings: record.detect.matchStrings === true,
      });
    }
  }

  const occurrencesById = new Map<string, DeprecationOccurrence[]>();
  if (detectors.length > 0) {
    for (const filePath of collectScannableFiles(root)) {
      scanFile(root, filePath, detectors, occurrencesById);
    }
  }

  const findings: DeprecationFinding[] = [];
  for (const { record, owner, severity } of applicable) {
    const occurrences = occurrencesById.get(record.id) ?? [];
    // A record with no detector cannot be located in source, so it is only
    // worth reporting when a human has to act on it regardless — which is
    // exactly the already-removed case.
    if (occurrences.length === 0 && (record.detect || severity !== "error")) continue;
    findings.push({
      id: record.id,
      package: owner.name,
      title: record.title,
      severity,
      since: record.since,
      removedIn: record.removedIn ?? null,
      installedVersion: owner.version,
      replacement: record.replacement ?? null,
      detail: record.detail ?? null,
      docs: record.docs ?? null,
      codemod:
        record.codemod && owner.directory
          ? resolveCodemodPath(owner.directory, record.codemod)
          : null,
      occurrences,
    });
  }

  findings.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "error" ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const packageManager = detectPackageManager(root);
  return {
    root,
    packageManager,
    upgradeCommand: upgradeCommandFor(packageManager, packages),
    packages,
    findings,
    warnings,
    ok: findings.every((finding) => finding.severity !== "error"),
  };
}

/** Keeps a manifest from pointing a codemod outside the package that ships it. */
function resolveCodemodPath(packageDirectory: string, codemod: string): string | null {
  if (isAbsolute(codemod)) return null;
  const resolved = resolve(packageDirectory, codemod);
  const base = resolve(packageDirectory);
  if (resolved !== base && !resolved.startsWith(`${base}/`)) return null;
  return existsSync(resolved) ? resolved : null;
}

// ---------------------------------------------------------------------------
// Codemods
// ---------------------------------------------------------------------------

export async function applyCodemods(report: UpgradeReport): Promise<CodemodResult> {
  const changedFiles = new Set<string>();
  const appliedIds: string[] = [];
  const skipped: { id: string; reason: string }[] = [];

  for (const finding of report.findings) {
    if (finding.occurrences.length === 0) continue;
    if (!finding.codemod) {
      skipped.push({ id: finding.id, reason: "no codemod is published for this deprecation" });
      continue;
    }

    let codemod: DeprecationCodemod;
    try {
      const loaded = (await import(pathToFileURL(finding.codemod).href)) as {
        default?: DeprecationCodemod;
      };
      if (!loaded.default || typeof loaded.default.transform !== "function") {
        throw new Error("module has no default export with a transform() function");
      }
      codemod = loaded.default;
    } catch (error) {
      skipped.push({
        id: finding.id,
        reason: `codemod failed to load (${(error as Error).message})`,
      });
      continue;
    }

    let applied = false;
    for (const file of new Set(finding.occurrences.map((entry) => entry.file))) {
      const fullPath = resolve(report.root, file);
      let source: string;
      try {
        source = readFileSync(fullPath, "utf-8");
      } catch {
        continue;
      }
      let next: string | null;
      try {
        next = codemod.transform(source, { path: fullPath });
      } catch (error) {
        skipped.push({
          id: finding.id,
          reason: `codemod threw on ${file} (${(error as Error).message})`,
        });
        next = null;
      }
      if (next === null || next === source) continue;
      writeFileSync(fullPath, next);
      changedFiles.add(file);
      applied = true;
    }
    if (applied) appliedIds.push(finding.id);
  }

  return { changedFiles: [...changedFiles].sort(), appliedIds, skipped };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatUpgradeReport(report: UpgradeReport): string {
  const lines: string[] = [];

  lines.push("Installed pracht packages");
  if (report.packages.length === 0) {
    lines.push("  none found — is this a pracht app with dependencies installed?");
  }
  const width = Math.max(0, ...report.packages.map((entry) => entry.name.length));
  for (const entry of report.packages) {
    const version = entry.version ?? "not installed";
    const declared = entry.declared ? `  (package.json: ${entry.declared})` : "  (transitive)";
    lines.push(`  ${entry.name.padEnd(width)}  ${version}${declared}`);
  }

  const errors = report.findings.filter((finding) => finding.severity === "error");
  const warns = report.findings.filter((finding) => finding.severity === "warn");

  lines.push("");
  if (report.findings.length === 0) {
    lines.push("No deprecated or removed APIs are in use.");
  } else {
    lines.push(
      `${errors.length} removed ${errors.length === 1 ? "API" : "APIs"} and ` +
        `${warns.length} ${warns.length === 1 ? "deprecation" : "deprecations"} in use.`,
    );
  }

  for (const finding of report.findings) {
    lines.push("");
    const label = finding.severity === "error" ? "REMOVED" : "DEPRECATED";
    lines.push(`${label}  ${finding.id} — ${finding.title}`);
    const version = finding.installedVersion ? ` (installed: ${finding.installedVersion})` : "";
    lines.push(
      finding.removedIn
        ? `  ${finding.severity === "error" ? "Removed" : "Removal scheduled"} in ${
            finding.package
          } ${finding.removedIn}${version}.`
        : `  Deprecated since ${finding.package} ${finding.since}${version}.`,
    );
    if (finding.replacement) lines.push(`  Replacement: ${finding.replacement}`);
    if (finding.detail) lines.push(`  ${finding.detail}`);
    if (finding.docs) lines.push(`  ${finding.docs}`);
    for (const occurrence of finding.occurrences) {
      lines.push(`    ${occurrence.file}:${occurrence.line}  ${occurrence.text}`);
    }
    if (finding.codemod) lines.push("  Codemod available — run `pracht upgrade --fix`.");
  }

  for (const warning of report.warnings) {
    lines.push("");
    lines.push(`WARN  ${warning}`);
  }

  if (report.upgradeCommand) {
    lines.push("");
    lines.push("Move the family forward together (pracht packages pin each other exactly):");
    lines.push(`  ${report.upgradeCommand}`);
  }

  return lines.join("\n");
}
