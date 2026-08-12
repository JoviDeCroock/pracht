import { isBuiltin } from "node:module";
import type { Plugin } from "vite";

/**
 * Reject server chunks that still depend on Node builtins when an adapter
 * targets an edge runtime. Keeping this as a standalone build plugin makes the
 * deployment boundary independently testable and keeps bundle inspection out
 * of the main virtual-module orchestration.
 */
export function createEdgeRuntimeSafetyPlugin(): Plugin {
  let isSsrBuild = false;

  return {
    name: "pracht:edge-runtime-safety",
    apply: "build",
    enforce: "post",

    configResolved(config) {
      isSsrBuild = !!config.build.ssr;
    },

    generateBundle(_options, bundle) {
      // Prefer Vite's environment identity when available and retain the
      // config flag for direct Rollup/plugin tests and older Vite contexts.
      const consumer = this.environment?.config?.consumer;
      const isServerBundle = consumer ? consumer === "server" : isSsrBuild;
      if (!isServerBundle) return;

      const survivors: Array<{ chunk: string; specifier: string }> = [];
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type !== "chunk") continue;
        for (const specifier of collectNodeBuiltinImports(this.parse(output.code))) {
          survivors.push({ chunk: fileName, specifier });
        }
      }

      if (survivors.length === 0) return;
      this.error(
        [
          "[pracht] Edge server bundle retains Node.js builtin imports that are unavailable at runtime:",
          ...survivors.map(({ chunk, specifier }) => `  - ${specifier} in ${chunk}`),
          "Remove the Node-only dependency or move that route to a Node deployment target.",
        ].join("\n"),
      );
    },
  };
}

function collectNodeBuiltinImports(program: unknown): Set<string> {
  const imports = new Set<string>();

  function sourceValue(node: unknown): string | null {
    if (!node || typeof node !== "object" || !("value" in node)) return null;
    return typeof node.value === "string" ? node.value : null;
  }

  function visit(node: unknown): void {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!node || typeof node !== "object") return;

    const record = node as Record<string, unknown>;
    const type = record.type;
    if (
      type === "ImportDeclaration" ||
      type === "ExportAllDeclaration" ||
      type === "ExportNamedDeclaration" ||
      type === "ImportExpression"
    ) {
      const specifier = sourceValue(record.source);
      if (specifier && isBuiltin(specifier)) imports.add(specifier);
    } else if (type === "CallExpression") {
      const callee = record.callee as Record<string, unknown> | undefined;
      const isImport = callee?.type === "Import";
      const isRequire = callee?.type === "Identifier" && callee.name === "require";
      if (isImport || isRequire) {
        const specifier = sourceValue((record.arguments as unknown[] | undefined)?.[0]);
        if (specifier && isBuiltin(specifier)) imports.add(specifier);
      }
    }

    for (const value of Object.values(record)) visit(value);
  }

  visit(program);
  return imports;
}
