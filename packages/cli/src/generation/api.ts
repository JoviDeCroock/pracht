import { displayPath, resolveApiModulePath, writeGeneratedFile } from "../project.js";
import type { ProjectConfig } from "../project.js";
import { parseApiMethods } from "../utils.js";
import { normalizeApiPath } from "./paths.js";
import { buildApiRouteSource } from "./source.js";
import type { GenerateResult } from "./types.js";

export interface ApiArgs {
  methods?: string;
  path: string;
}

export function generateApi(args: ApiArgs, project: ProjectConfig): GenerateResult {
  const endpointPath = normalizeApiPath(args.path);
  const methods = parseApiMethods(args.methods);
  const apiFile = resolveApiModulePath(project, endpointPath);
  writeGeneratedFile(apiFile.absolutePath, buildApiRouteSource({ endpointPath, methods }));

  return {
    created: [displayPath(project.root, apiFile.absolutePath)],
    kind: "api",
    updated: [],
  };
}
