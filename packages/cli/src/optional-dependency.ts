/**
 * Optional peer dependencies of `@pracht/cli`: packages only one command
 * needs, which the app installs when it uses that command so that every other
 * app's install stays small.
 */

/** The dev-dependency install command for the package manager running the CLI. */
export function installCommand(packageName: string, userAgent = process.env.npm_config_user_agent) {
  const manager = userAgent?.split("/")[0];
  if (manager === "pnpm") return `pnpm add -D ${packageName}`;
  if (manager === "yarn") return `yarn add -D ${packageName}`;
  if (manager === "bun") return `bun add -d ${packageName}`;
  return `npm install -D ${packageName}`;
}

/** Whether `error` says `packageName` itself (not one of its imports) is not installed. */
export function isMissingPackage(error: unknown, packageName: string): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return (
    (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") &&
    (error.message.includes(`'${packageName}'`) || error.message.includes(`"${packageName}"`))
  );
}

export function missingOptionalDependencyError(
  packageName: string,
  feature: string,
  cause?: unknown,
): Error {
  return new Error(
    `${feature} needs ${packageName}, which @pracht/cli does not install by default. ` +
      `Add it to the app: ${installCommand(packageName)}`,
    cause === undefined ? undefined : { cause },
  );
}

/** Load Playwright's browser driver for the commands that launch Chrome. */
export async function loadPlaywrightCore(
  feature: string,
): Promise<typeof import("playwright-core")> {
  try {
    return await import("playwright-core");
  } catch (error) {
    if (isMissingPackage(error, "playwright-core")) {
      throw missingOptionalDependencyError("playwright-core", feature, error);
    }
    throw error;
  }
}
