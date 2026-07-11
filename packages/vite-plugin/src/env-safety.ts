import type { Plugin } from "vite";

/**
 * Env vars Vite defines on `import.meta.env` in every bundle, plus NODE_ENV
 * which Vite's define pass statically replaces at build time (so it can never
 * leak and is referenced by countless dependencies).
 */
export const VITE_BUILTIN_ENV_VARS = new Set([
  "MODE",
  "DEV",
  "PROD",
  "SSR",
  "BASE_URL",
  "NODE_ENV",
]);

/** Prefix that marks an env var as intentionally public. */
export const PUBLIC_ENV_PREFIX = "PRACHT_PUBLIC_";
export const VITE_PUBLIC_ENV_PREFIX = "VITE_";
const PUBLIC_ENV_PREFIXES = [PUBLIC_ENV_PREFIX, VITE_PUBLIC_ENV_PREFIX] as const;

/** Server-only core entry that must never resolve into client bundles. */
export const SERVER_ENV_MODULE_ID = "@pracht/core/env/server";

export interface EnvSafetyReport {
  findings: EnvLeakProblem[];
  version: 1;
}

export interface EnvSafetyOptions {
  /** Env var names allowed to appear in client bundles despite not being public. */
  allow?: string[];
}

export interface EnvLeakReference {
  accessor: "process.env" | "import.meta.env";
  name: string;
}

// Matches `process.env.X`, `import.meta.env.X`, and the equivalent
// bracket-string forms (`process.env["X"]`, `import.meta.env['X']`).
const ENV_REFERENCE_RE =
  /\b(process\.env|import\.meta\.env)(?:\.([A-Za-z_$][A-Za-z0-9_$]*)|\[\s*(["'])([A-Za-z_$][A-Za-z0-9_$]*)\3\s*\])/g;

/**
 * Scans JavaScript source for references to environment variables that are
 * neither public-prefixed, Vite built-ins, nor explicitly allowed.
 */
export function scanCodeForEnvLeaks(
  code: string,
  allow: ReadonlySet<string> = new Set(),
): EnvLeakReference[] {
  const findings: EnvLeakReference[] = [];
  const seen = new Set<string>();
  const codePositions = getCodePositionMask(code);

  for (const match of code.matchAll(ENV_REFERENCE_RE)) {
    if (!codePositions[match.index ?? -1]) continue;
    const accessor = match[1] as EnvLeakReference["accessor"];
    const name = match[2] ?? match[4];
    if (!name) continue;
    if (PUBLIC_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    if (VITE_BUILTIN_ENV_VARS.has(name)) continue;
    if (allow.has(name)) continue;

    const key = `${accessor}.${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({ accessor, name });
  }

  return findings;
}

function getCodePositionMask(code: string): Uint8Array {
  const mask = new Uint8Array(code.length);
  const templateExpressionDepths: number[] = [];
  let mode: "block-comment" | "code" | "double" | "line-comment" | "regex" | "single" | "template" =
    "code";
  let regexCharClass = false;
  let i = 0;

  while (i < code.length) {
    const char = code[i];
    const next = code[i + 1];

    if (mode === "line-comment") {
      if (char === "\n" || char === "\r") {
        mode = "code";
        mask[i] = 1;
      }
      i++;
      continue;
    }

    if (mode === "block-comment") {
      if (char === "*" && next === "/") {
        mode = "code";
        i += 2;
      } else {
        i++;
      }
      continue;
    }

    if (mode === "single" || mode === "double") {
      const quote = mode === "single" ? "'" : '"';
      if (char === "\\") {
        i += 2;
        continue;
      }
      if (char === quote || char === "\n" || char === "\r") {
        mode = "code";
      }
      i++;
      continue;
    }

    if (mode === "regex") {
      if (char === "\\") {
        i += 2;
        continue;
      }
      if (char === "[") {
        regexCharClass = true;
        i++;
        continue;
      }
      if (char === "]") {
        regexCharClass = false;
        i++;
        continue;
      }
      if (char === "/" && !regexCharClass) {
        regexCharClass = false;
        i++;
        while (i < code.length && isIdentifierChar(code[i])) i++;
        mode = "code";
        continue;
      }
      if (char === "\n" || char === "\r") {
        regexCharClass = false;
        mode = "code";
      }
      i++;
      continue;
    }

    if (mode === "template") {
      if (char === "\\") {
        i += 2;
        continue;
      }
      if (char === "`") {
        mode = "code";
        i++;
        continue;
      }
      if (char === "$" && next === "{") {
        mask[i] = 1;
        mask[i + 1] = 1;
        templateExpressionDepths.push(1);
        mode = "code";
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    mask[i] = 1;

    if (char === "/" && next === "/") {
      mask[i + 1] = 1;
      mode = "line-comment";
      i += 2;
      continue;
    }

    if (char === "/" && next === "*") {
      mask[i + 1] = 1;
      mode = "block-comment";
      i += 2;
      continue;
    }

    if (char === "/" && isRegexLiteralStart(code, i)) {
      mode = "regex";
      regexCharClass = false;
      i++;
      continue;
    }

    if (char === "'") {
      mode = "single";
      i++;
      continue;
    }

    if (char === '"') {
      mode = "double";
      i++;
      continue;
    }

    if (char === "`") {
      mode = "template";
      i++;
      continue;
    }

    if (templateExpressionDepths.length > 0) {
      const top = templateExpressionDepths.length - 1;
      if (char === "{") {
        templateExpressionDepths[top]++;
      } else if (char === "}") {
        templateExpressionDepths[top]--;
        if (templateExpressionDepths[top] === 0) {
          templateExpressionDepths.pop();
          mode = "template";
        }
      }
    }

    i++;
  }

  return mask;
}

function isRegexLiteralStart(code: string, slashIndex: number): boolean {
  let i = slashIndex - 1;
  while (i >= 0 && /\s/.test(code[i])) i--;
  if (i < 0) return true;

  const previous = code[i];
  if (previous === ">" && code[i - 1] === "=") return true;
  if ("([{=,:;!?&|^~<>*%+-".includes(previous)) return true;

  if (isIdentifierChar(previous)) {
    let start = i;
    while (start >= 0 && isIdentifierChar(code[start])) start--;
    const word = code.slice(start + 1, i + 1);
    return new Set([
      "await",
      "case",
      "delete",
      "do",
      "else",
      "in",
      "instanceof",
      "new",
      "of",
      "return",
      "throw",
      "typeof",
      "void",
      "yield",
    ]).has(word);
  }

  return false;
}

function isIdentifierChar(char: string | undefined): boolean {
  return !!char && /[A-Za-z0-9_$]/.test(char);
}

interface EnvLeakProblem extends EnvLeakReference {
  chunk: string;
  sources: string[];
}

export function formatEnvLeakError(problems: EnvLeakProblem[]): string {
  const lines = problems.map((problem) => {
    const source =
      problem.sources.length > 0
        ? ` (likely from ${problem.sources.map((file) => JSON.stringify(file)).join(", ")})`
        : "";
    return `  - ${problem.accessor}.${problem.name} in chunk "${problem.chunk}"${source}`;
  });

  return [
    "[pracht] Environment variable leak detected in the client bundle:",
    ...lines,
    "",
    `Only PRACHT_PUBLIC_- or VITE_-prefixed variables may be referenced in client code (prefer publicEnv from "@pracht/core" for typed PRACHT_PUBLIC_ values).`,
    `Move server-only reads into loaders/API routes and access them via serverEnv from "@pracht/core/env/server",`,
    "or allowlist intentionally-safe names with pracht({ envSafety: { allow: [...] } }).",
  ].join("\n");
}

function stripIdQuery(id: string): string {
  const queryStart = id.indexOf("?");
  return queryStart === -1 ? id : id.slice(0, queryStart);
}

/**
 * Build-time leak detection: scans rendered client chunks for references to
 * non-public env vars and fails the build with the variable, chunk, and the
 * likely source module.
 */
export function createEnvSafetyPlugin(envSafety: false | EnvSafetyOptions): Plugin {
  const allow = new Set(envSafety === false ? [] : (envSafety.allow ?? []));
  // moduleId (query-stripped) → env references found in its transformed
  // source. Bundlers rewrite `process.env.X` in client output (rolldown emits
  // `{}.X`) and replace unknown `import.meta.env.X`, so module sources —
  // captured after the server-only export strip has run — are the reliable
  // signal; the chunk scan below is a literal-survival backstop.
  const moduleEnvReferences = new Map<string, EnvLeakReference[]>();
  let isSsrBuild = false;

  return {
    name: "pracht:env-safety",
    apply: "build",
    enforce: "post",

    configResolved(config) {
      isSsrBuild = !!config.build.ssr;
    },

    transform(code, id, transformOptions) {
      if (envSafety === false) return null;
      if (transformOptions?.ssr) return null;

      const moduleId = stripIdQuery(id);
      // Dependencies commonly reference define-replaced env in ways that are
      // safe after bundling; only first-party modules are attributed. Leaks
      // that survive verbatim in dependency code are still caught by the
      // chunk scan in generateBundle.
      if (moduleId.includes("node_modules")) return null;

      const findings = scanCodeForEnvLeaks(code, allow);
      if (findings.length > 0) {
        moduleEnvReferences.set(moduleId, findings);
      }
      return null;
    },

    generateBundle(_options, bundle) {
      if (envSafety === false) return;

      // Only client bundles are scanned. Prefer the environment API when the
      // hook runs inside a Vite environment; fall back to the build's ssr flag.
      const consumer = this.environment?.config?.consumer;
      const isClientBundle = consumer ? consumer === "client" : !isSsrBuild;
      if (!isClientBundle) return;

      const problems: EnvLeakProblem[] = [];
      const seen = new Set<string>();
      const addProblem = (problem: EnvLeakProblem): void => {
        const key = `${problem.chunk}:${problem.accessor}.${problem.name}`;
        if (seen.has(key)) return;
        seen.add(key);
        problems.push(problem);
      };

      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type !== "chunk") continue;
        const moduleIds = (output.moduleIds ?? Object.keys(output.modules ?? {})).map(stripIdQuery);

        // References recorded from module sources that made it into the chunk.
        for (const moduleId of moduleIds) {
          const references = moduleEnvReferences.get(moduleId);
          if (!references) continue;
          for (const reference of references) {
            addProblem({ ...reference, chunk: fileName, sources: [moduleId] });
          }
        }

        // Literal references that survived into the rendered chunk (covers
        // dependencies and bundlers that keep the accessor text intact).
        for (const finding of scanCodeForEnvLeaks(output.code, allow)) {
          const sources = moduleIds.filter((moduleId) =>
            moduleEnvReferences.get(moduleId)?.some((reference) => reference.name === finding.name),
          );
          addProblem({ ...finding, chunk: fileName, sources });
        }
      }

      if (problems.length > 0) {
        this.error(formatEnvLeakError(problems));
      }

      this.emitFile({
        fileName: "_pracht/env-safety.json",
        source: JSON.stringify(
          { findings: problems, version: 1 } satisfies EnvSafetyReport,
          null,
          2,
        ),
        type: "asset",
      });
    },
  };
}
