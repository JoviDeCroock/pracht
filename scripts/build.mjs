// Content-addressed, topologically parallel workspace build.
//
// `pnpm -r run build` rebuilds all 17 packages every time and walks the
// dependency graph four packages at a time. Almost every `verify` run follows
// an edit to one or two packages, so almost all of that work re-derives output
// that is already on disk byte-for-byte.
//
// This runner keeps the same topological ordering and the same per-package
// `build` scripts. It adds two things:
//
//   - A cache keyed on what a package's build actually reads: its own sources,
//     and the *outputs* of the workspace packages it depends on. Keying
//     dependents on a dependency's output rather than its input matters: a
//     rebuild that produces identical bytes must not cascade.
//   - A scheduler that starts every package whose dependencies are done,
//     rather than pnpm's fixed concurrency.
//
//   node scripts/build.mjs           build what is stale
//   node scripts/build.mjs --force   ignore the cache
//   node scripts/build.mjs --json    machine-readable summary
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = resolve(repoRoot, "packages");
const cachePath = resolve(repoRoot, "node_modules/.cache/pracht-build/manifest.json");

const args = new Set(process.argv.slice(2));
const force = args.has("--force");
const asJson = args.has("--json");

/**
 * Directories and files under a package that its build never reads. Tests are
 * the important entry: every `tsdown.config.ts` in this repo takes its entries
 * from `src/`, so a test-only edit produces identical output, and hashing it
 * would rebuild the package (and re-hash every dependent) for nothing.
 */
const IGNORED_INPUTS = new Set([
  "node_modules",
  "dist",
  "test",
  "CHANGELOG.md",
  "README.md",
  "LICENSE",
]);

/**
 * Where each package writes its build output, and anything it reads from
 * outside its own directory. Both are cache correctness inputs: the output
 * paths are re-hashed to notice a deleted or hand-edited `dist/`, and the
 * external inputs are hashed alongside the package's own sources.
 */
const PACKAGE_OVERRIDES = {
  // `scripts/sync-skills.js` copies `<repo>/skills/*/SKILL.md` into the
  // package, so the repo-level skills are inputs and `skills/` is the output.
  "create-pracht": { externalInputs: ["skills"], outputs: ["skills"] },
};

function hashFileInto(hash, absolutePath, label) {
  hash.update(label);
  hash.update("\0");
  hash.update(readFileSync(absolutePath));
  hash.update("\0");
}

/** Hash a directory tree in a stable order, or return null when it is absent. */
function hashTree(root, { skip = () => false } = {}) {
  if (!existsSync(root)) return null;
  const hash = createHash("sha256");
  let sawFile = false;

  const walk = (dir) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      const absolute = join(dir, entry.name);
      const label = relative(root, absolute);
      if (skip(label, entry)) continue;
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.isFile()) {
        sawFile = true;
        hashFileInto(hash, absolute, label);
      }
    }
  };

  walk(root);
  // An empty output directory is not a build: treat it as missing so the
  // package rebuilds rather than caching a hash of nothing.
  return sawFile ? hash.digest("hex") : null;
}

function readPackages() {
  const packages = new Map();
  for (const name of readdirSync(packagesRoot)) {
    const dir = resolve(packagesRoot, name);
    const manifestPath = join(dir, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    if (!manifest.scripts?.build) continue;
    const overrides = PACKAGE_OVERRIDES[manifest.name] ?? {};
    packages.set(manifest.name, {
      name: manifest.name,
      dir,
      externalInputs: overrides.externalInputs ?? [],
      outputs: overrides.outputs ?? ["dist"],
      deps: [],
    });
  }

  // Resolve workspace edges after every package is known, so the graph only
  // contains packages this runner actually builds.
  for (const pkg of packages.values()) {
    const manifest = JSON.parse(readFileSync(join(pkg.dir, "package.json"), "utf-8"));
    const declared = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
    };
    pkg.deps = Object.entries(declared)
      .filter(([dep, range]) => String(range).startsWith("workspace:") && packages.has(dep))
      .map(([dep]) => dep)
      .sort();
  }
  return packages;
}

/**
 * Inputs shared by every package: a dependency upgrade or a change to this
 * runner invalidates the whole cache rather than silently reusing output built
 * against different tooling.
 */
function globalSalt() {
  const hash = createHash("sha256");
  hash.update(process.version.split(".")[0]);
  for (const file of ["pnpm-lock.yaml", "scripts/build.mjs", "tsconfig.json"]) {
    hashFileInto(hash, resolve(repoRoot, file), file);
  }
  return hash.digest("hex");
}

function inputHashOf(pkg, salt) {
  const hash = createHash("sha256");
  hash.update(salt);
  const own = hashTree(pkg.dir, {
    skip: (label) => IGNORED_INPUTS.has(label) || pkg.outputs.includes(label),
  });
  hash.update(String(own));
  for (const input of pkg.externalInputs) {
    hash.update(input);
    hash.update(String(hashTree(resolve(repoRoot, input))));
  }
  return hash.digest("hex");
}

function outputHashOf(pkg) {
  const hash = createHash("sha256");
  let present = false;
  for (const output of pkg.outputs) {
    const tree = hashTree(resolve(pkg.dir, output));
    if (tree !== null) present = true;
    hash.update(output);
    hash.update(String(tree));
  }
  return present ? hash.digest("hex") : null;
}

function runBuild(pkg) {
  return new Promise((resolveTask) => {
    const child = spawn("pnpm", ["--dir", pkg.dir, "run", "build"], {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", (error) => resolveTask({ ok: false, output: String(error) }));
    child.on("close", (code) => resolveTask({ ok: code === 0, output }));
  });
}

const packages = new Map(readPackages());
const salt = globalSalt();

let cache = {};
if (!force && existsSync(cachePath)) {
  try {
    cache = JSON.parse(readFileSync(cachePath, "utf-8"));
  } catch {
    // A truncated cache means a rebuild, never a wrong answer.
    cache = {};
  }
}

const records = {};
const states = new Map(); // name -> "cached" | "built"
const failures = [];
const startedAt = Date.now();

/** Run `task` over the graph, starting each package as soon as its deps land. */
async function schedule(names, limit, task) {
  const done = new Set();
  const inFlight = new Map();
  const pending = new Set(names);
  let aborted = false;

  while ((pending.size > 0 || inFlight.size > 0) && !aborted) {
    for (const name of pending) {
      if (inFlight.size >= limit) break;
      if (!packages.get(name).deps.every((dep) => done.has(dep))) continue;
      pending.delete(name);
      inFlight.set(
        name,
        task(packages.get(name)).then((ok) => ({ name, ok })),
      );
    }

    if (inFlight.size === 0) {
      // Nothing running and nothing startable: the workspace edges form a
      // cycle. Say so rather than exiting zero having built only part of it.
      failures.push({
        name: [...pending].join(", "),
        output: "dependency cycle between workspace packages: none of these can start",
      });
      return;
    }
    const settled = await Promise.race(inFlight.values());
    inFlight.delete(settled.name);
    if (settled.ok) {
      done.add(settled.name);
    } else {
      // Let in-flight work finish, but do not start anything new.
      aborted = true;
      await Promise.all(inFlight.values());
    }
  }
}

await schedule(packages.keys(), Math.max(2, availableParallelism()), async (pkg) => {
  const inputHash = inputHashOf(pkg, salt);
  const depsFingerprint = pkg.deps.map((dep) => `${dep}:${records[dep].outputHash}`).join("|");
  const cached = cache[pkg.name];
  const outputHash = outputHashOf(pkg);

  if (
    !force &&
    cached &&
    outputHash !== null &&
    cached.inputHash === inputHash &&
    cached.depsFingerprint === depsFingerprint &&
    cached.outputHash === outputHash
  ) {
    records[pkg.name] = { inputHash, depsFingerprint, outputHash };
    states.set(pkg.name, "cached");
    return true;
  }

  const result = await runBuild(pkg);
  if (!result.ok) {
    failures.push({ name: pkg.name, output: result.output });
    return false;
  }

  const built = outputHashOf(pkg);
  if (built === null) {
    failures.push({
      name: pkg.name,
      output: `build succeeded but wrote no output to ${pkg.outputs.join(", ")}`,
    });
    return false;
  }
  records[pkg.name] = { inputHash, depsFingerprint, outputHash: built };
  states.set(pkg.name, "built");
  return true;
});

// Entries proven this run win; entries from previous runs survive. That matters
// on the path an agent iterates on: when one package fails to build, everything
// downstream of it never starts, and dropping their records would rebuild them
// from scratch on the next attempt for no reason. Keeping a stale entry cannot
// cause a wrong skip — the check above re-derives the input hash, the
// dependency fingerprint and the output hash every run, and all three have to
// match. `records` itself stays free of unproven entries because the dependency
// fingerprint reads from it, and a dependency that has not run this time must
// not contribute a previous run's output hash.
mkdirSync(dirname(cachePath), { recursive: true });
writeFileSync(cachePath, `${JSON.stringify({ ...cache, ...records }, null, 2)}\n`, "utf-8");

const built = [...states].filter(([, state]) => state === "built").map(([name]) => name);
const cachedNames = [...states].filter(([, state]) => state === "cached").map(([name]) => name);
const seconds = (Date.now() - startedAt) / 1000;

if (asJson) {
  console.log(JSON.stringify({ built, cached: cachedNames, failures, seconds }, null, 2));
} else {
  for (const failure of failures) {
    console.error(`\nbuild failed: ${failure.name}\n${failure.output.trimEnd()}`);
  }
  const summary = built.length > 0 ? `built ${built.join(", ")}` : "nothing to build";
  console.log(`build: ${summary} (${cachedNames.length} cached, ${seconds.toFixed(1)}s)`);
}

process.exit(failures.length === 0 ? 0 : 1);
