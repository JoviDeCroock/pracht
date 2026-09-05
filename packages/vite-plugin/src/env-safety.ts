import type { Plugin } from "vite";
import {
  PUBLIC_ENV_PREFIX,
  VITE_BUILTIN_ENV_VARS,
  WHOLE_ENV_READ,
  scanCodeForEnvLeaks,
} from "@pracht/capabilities/static";
import type { EnvLeakReference } from "@pracht/capabilities/static";
export {
  PUBLIC_ENV_PREFIX,
  VITE_BUILTIN_ENV_VARS,
  WHOLE_ENV_READ,
  scanCodeForEnvLeaks,
} from "@pracht/capabilities/static";
export type { EnvLeakReference } from "@pracht/capabilities/static";

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
    const reference =
      problem.name === WHOLE_ENV_READ
        ? "import.meta.env read as a whole object"
        : `${problem.accessor}.${problem.name}`;
    return `  - ${reference} in chunk "${problem.chunk}"${source}`;
  });

  const wholeEnvGuidance = problems.some((problem) => problem.name === WHOLE_ENV_READ)
    ? [
        "",
        "A whole-object `import.meta.env` read (bare reference, destructuring, spread, or bracket access)",
        "is replaced at build time by an object literal containing every exposed variable — including the",
        "`VITE_` values Pracht does not treat as public. Read one key at a time (`import.meta.env.KEY`).",
      ]
    : [];

  return [
    "[pracht] Environment variable leak detected in the client bundle:",
    ...lines,
    ...wholeEnvGuidance,
    "",
    `Only PRACHT_PUBLIC_-prefixed variables may be referenced in client code (prefer publicEnv from "@pracht/core" for typed public values).`,
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
