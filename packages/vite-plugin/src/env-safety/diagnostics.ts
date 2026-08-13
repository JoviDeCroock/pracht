import { WHOLE_ENV_READ, type EnvLeakProblem } from "./model.ts";

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
