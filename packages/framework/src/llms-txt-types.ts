import type { ModuleRegistry, ResolvedApiRoute, ResolvedPrachtApp } from "./types.ts";

export type LlmsTxtSection = "pages" | "api" | "capabilities";

export interface BuildLlmsTxtOptions {
  app: ResolvedPrachtApp;
  apiRoutes?: readonly ResolvedApiRoute[];
  registry?: ModuleRegistry;
  /** H1 project title — the only required llms.txt element. */
  title: string;
  /** Blockquote summary rendered under the title. Omitted when empty. */
  description?: string;
  /**
   * Origin (e.g. "https://example.com") prepended to every link so the file
   * contains absolute URLs. Links stay root-relative when omitted.
   */
  origin?: string;
  /** Sections to emit. Defaults to "pages", "api", and "capabilities". */
  include?: readonly LlmsTxtSection[];
  /**
   * Route/API path patterns to leave out, using the same segment globs as
   * `defineApp({ constraints })` (`*` = one segment, trailing `**` = the rest).
   *
   * llms.txt is a list of URLs an agent is invited to fetch, so anything an
   * anonymous agent cannot actually use — pages behind an auth middleware,
   * internal tooling, deliberate error routes — belongs here. Patterns are
   * matched against the emitted paths, so a prerendered instance of a dynamic
   * route (`/blog/hello-world`) is covered by `/blog/**`, and a capability is
   * excluded by its dispatch path (`/api/capabilities/**`).
   *
   * Framework-reserved paths (any `_pracht` or `__pracht` segment, such as the
   * `@pracht/image` endpoint at `/api/_pracht/image`) are always omitted and
   * do not need an entry here.
   */
  exclude?: readonly string[];
}
