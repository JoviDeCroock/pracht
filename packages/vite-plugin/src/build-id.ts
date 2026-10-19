import { createBuildId, PRACHT_BUILD_ID_ENV } from "@pracht/core/adapter";

let processBuildId: string | undefined;

/**
 * The `buildId` a generated server entry carries. `pracht build` creates one
 * per run and passes it through the environment; a build it did not start
 * gets one per process, and the dev server a fixed one.
 */
export function resolveServerEntryBuildId(isBuild: boolean | undefined): string {
  if (!isBuild) return "dev";
  const fromCli = process.env[PRACHT_BUILD_ID_ENV];
  if (fromCli) return fromCli;
  processBuildId ??= createBuildId();
  return processBuildId;
}
