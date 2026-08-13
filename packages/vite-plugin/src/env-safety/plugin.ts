import type { Plugin } from "vite";
import { formatEnvLeakError } from "./diagnostics.ts";
import type {
  EnvLeakProblem,
  EnvLeakReference,
  EnvSafetyOptions,
  EnvSafetyReport,
} from "./model.ts";
import { scanCodeForEnvLeaks } from "./source-scan.ts";

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
      if (findings.length > 0) moduleEnvReferences.set(moduleId, findings);
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

      if (problems.length > 0) this.error(formatEnvLeakError(problems));

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

function stripIdQuery(id: string): string {
  const queryStart = id.indexOf("?");
  return queryStart === -1 ? id : id.slice(0, queryStart);
}
