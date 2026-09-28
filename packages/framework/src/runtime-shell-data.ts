/**
 * Shell loader data, provided to the shell and the routes inside it.
 *
 * It lives in its own context rather than on the route runtime so that an app
 * whose shells export no loader ships none of it: the client router only
 * provides it when `__PRACHT_SHELL_LOADERS__` is not `false`, and the plugin
 * sets that define to `false` for a build in which no shell has a loader.
 */
import { createContext } from "preact";

export interface ShellDataValue {
  /** Name of the shell the active route renders under. */
  shell: string | undefined;
  /** The shell loader's data; `undefined` when it has none or it did not run. */
  data: unknown;
}

export const ShellDataContext = /* @__PURE__ */ createContext<ShellDataValue | undefined>(
  undefined,
);

let shellDataCommitter: ((data: unknown) => void) | undefined;

/** @internal Installed by the client router, which owns the shell data on screen. */
export function setShellDataCommitter(committer: ((data: unknown) => void) | undefined): void {
  shellDataCommitter = committer;
}

/**
 * @internal Replace the shell data on screen with a revalidated value. The
 * caller checks that the revalidation still belongs to the route on screen.
 */
export function commitShellData(data: unknown): void {
  shellDataCommitter?.(data);
}
