import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * pnpm blocks dependency install scripts unless they are allowlisted, and
 * esbuild and workerd both need theirs — workerd's postinstall downloads the
 * runtime binary, so without this `wrangler dev` fails right after scaffolding
 * with `ERR_PNPM_IGNORED_BUILDS`.
 *
 * This has to live in `pnpm-workspace.yaml`: pnpm 10 uses
 * `onlyBuiltDependencies`, while pnpm 11 uses `allowBuilds` and no longer reads
 * the `pnpm` field in package.json. npm and yarn ignore this file entirely, so
 * it is inert for them. (npm has its own `allow-scripts` prompt, which it
 * drives interactively.)
 */
export function pnpmBuildAllowlist(adapter, tailwind) {
  const packages = ["esbuild"];
  if (adapter.id === "cloudflare") packages.push("workerd");
  if (tailwind) packages.push("@tailwindcss/oxide");
  return packages.sort();
}

export function pnpmBuildPolicyName(pnpmMajor) {
  return pnpmMajor <= 10 ? "onlyBuiltDependencies" : "allowBuilds";
}

export function createPnpmWorkspaceConfig(adapter, tailwind, pnpmMajor) {
  const policy = pnpmBuildPolicyName(pnpmMajor);
  const entries = pnpmBuildAllowlist(adapter, tailwind);

  return [
    "packages:",
    '  - "."',
    `${policy}:`,
    ...(policy === "onlyBuiltDependencies"
      ? entries.map((name) => `  - ${JSON.stringify(name)}`)
      : entries.map((name) => `  ${JSON.stringify(name)}: true`)),
    "",
  ].join("\n");
}

/**
 * Nearest ancestor `pnpm-workspace.yaml` above `dir`, or null.
 *
 * pnpm resolves settings from the workspace *root*, so writing our own file
 * inside an existing monorepo would be read by nobody — while also re-rooting
 * the workspace for anyone who runs `pnpm install` from the app directory,
 * which detaches it from its siblings.
 */
export function findAncestorPnpmWorkspace(dir) {
  let current = resolve(dir, "..");
  for (;;) {
    const configPath = resolve(current, "pnpm-workspace.yaml");
    // An ancestor config only governs this app if its `packages:` globs cover
    // it. Suppressing our own file for a workspace the app is *not* a member of
    // leaves it with no install at all: pnpm re-roots to the ancestor and
    // installs that workspace's projects instead.
    if (existsSync(configPath) && workspaceCovers(configPath, current, dir)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Whether `dir` matches one of the `packages:` globs in a pnpm workspace
 * config. A deliberately small YAML reader: the block and flow list forms pnpm
 * accepts, and `*` / `**` globs.
 *
 * Both failure directions matter, and they are not symmetric. Deciding "not a
 * member" for a directory that *is* one writes a nested `pnpm-workspace.yaml`
 * that re-roots the workspace at the app; deciding "member" for one that is
 * not only prints instructions. So anything this reader cannot confidently
 * decide answers `true`.
 */
function workspaceCovers(configPath, workspaceRoot, dir) {
  let contents;
  try {
    contents = readFileSync(configPath, "utf-8");
  } catch {
    return true;
  }

  const globs = [];
  let sawPackagesKey = false;
  let inBlockList = false;

  for (const rawLine of contents.split("\n")) {
    const line = rawLine.replace(/#.*$/, "");
    const packagesKey = line.match(/^packages\s*:(.*)$/);
    if (packagesKey) {
      sawPackagesKey = true;
      // Flow form: `packages: ["apps/*", "tools/*"]`, which pnpm accepts.
      const flow = packagesKey[1].trim();
      if (flow.startsWith("[")) {
        for (const entry of flow.replace(/^\[|\]$/g, "").split(",")) {
          const value = entry.trim().replace(/^["']|["']$/g, "");
          if (value) globs.push(value);
        }
        inBlockList = false;
      } else {
        inBlockList = true;
      }
      continue;
    }
    if (inBlockList) {
      const item = line.match(/^\s+-\s*["']?([^"'\s]+)["']?\s*$/);
      if (item) {
        globs.push(item[1]);
        continue;
      }
      if (line.trim() !== "") inBlockList = false;
    }
  }

  // No `packages:` key at all is a single-package workspace rooted there,
  // which does not cover a nested app. A key we could not read is a decision
  // we cannot make — fall to "member".
  if (!sawPackagesKey) return false;
  if (globs.length === 0) return true;

  const relative = resolve(dir)
    .slice(resolve(workspaceRoot).length + 1)
    .split(/[\\/]/);
  // A negation (`!apps/legacy`) narrows the set; treat its presence as
  // undecidable rather than as an ordinary glob.
  if (globs.some((glob) => glob.startsWith("!"))) return true;
  // pnpm treats a workspace-root-relative `./apps/*` the same as `apps/*`.
  // Strip only that harmless prefix before comparing path segments.
  const normalizedGlobs = globs.map((glob) => glob.replace(/^(?:\.\/)+/, ""));
  // pnpm accepts the wider glob syntax supported by its workspace matcher.
  // This intentionally small matcher cannot safely decide braces, character
  // classes, extglobs, or single-character wildcards. Follow the conservative
  // contract above instead of creating a nested workspace for a real member.
  if (normalizedGlobs.some((glob) => /[?[\]{}()]/.test(glob))) return true;
  return normalizedGlobs.some((glob) => matchesGlobSegments(glob.split("/"), relative));
}

/**
 * Segment-wise glob match. `**` matches the rest; otherwise a segment may
 * contain `*` wildcards (`app-*`), which pnpm supports.
 */
function matchesGlobSegments(globSegments, pathSegments) {
  return matchGlobSegmentAt(globSegments, pathSegments, 0, 0);
}

function matchGlobSegmentAt(globSegments, pathSegments, globIndex, pathIndex) {
  if (globIndex === globSegments.length) return pathIndex === pathSegments.length;

  const segment = globSegments[globIndex];
  if (segment === "**") {
    if (globIndex === globSegments.length - 1) return true;
    for (let nextPathIndex = pathIndex; nextPathIndex <= pathSegments.length; nextPathIndex += 1) {
      if (matchGlobSegmentAt(globSegments, pathSegments, globIndex + 1, nextPathIndex)) return true;
    }
    return false;
  }

  return (
    pathIndex < pathSegments.length &&
    segmentMatches(segment, pathSegments[pathIndex]) &&
    matchGlobSegmentAt(globSegments, pathSegments, globIndex + 1, pathIndex + 1)
  );
}

function segmentMatches(glob, value) {
  if (glob === "*") return true;
  if (!glob.includes("*")) return glob === value;
  const pattern = glob
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${pattern}$`).test(value);
}
