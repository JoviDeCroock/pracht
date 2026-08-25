import type { RenderMode } from "@pracht/core";
import type { PreactSsrPrecompileOptions } from "@pracht/preact-ssr-precompile";
import type { EnvSafetyOptions } from "./env-safety.ts";
import { createDefaultNodeAdapter, type PrachtAdapter } from "./plugin-adapter.ts";
import { normalizeAdditionalExtensions } from "./route-extensions.ts";

export type LlmsTxtSection = "pages" | "api" | "capabilities";

export interface PrachtLlmsTxtOptions {
  /** H1 title. Defaults to the app's package.json `name`. */
  title?: string;
  /**
   * Blockquote summary under the title. Defaults to the app's package.json
   * `description`; omitted when neither is set.
   */
  description?: string;
  /**
   * Origin (e.g. "https://example.com") prepended to every link so llms.txt
   * contains absolute URLs. Links stay root-relative when omitted.
   */
  origin?: string;
  /** Sections to emit. Defaults to ["pages", "api", "capabilities"]. */
  include?: LlmsTxtSection[];
  /**
   * Route/API path patterns to leave out, using the same segment globs as
   * `defineApp({ constraints })` (`*` = one segment, trailing `**` = the
   * rest). llms.txt invites agents to fetch every URL it lists, so exclude
   * anything an anonymous agent cannot use — pages behind an auth middleware,
   * internal tooling, deliberate error routes. Capabilities are matched by
   * their dispatch path (`/api/capabilities/**`).
   *
   * ```ts
   * llmsTxt: { exclude: ["/dashboard", "/admin/**"] }
   * ```
   */
  exclude?: string[];
}

/**
 * Optional client-router features, compiled out of the client bundle when
 * disabled. Every one defaults to `true`. Turn a feature off only when the app
 * really does not use it: the router silently stops honouring the
 * corresponding route options and `<Link>` props.
 */
export interface PrachtClientOptions {
  /**
   * JS prefetching of route-state JSON and route/shell chunks, driven by
   * `route({ prefetch })` and `<Link prefetch>`. Off also drops the separate
   * prefetch chunk the router loads on every page, and makes the imperative
   * `prefetch()` export a no-op.
   */
  prefetch?: boolean;
}

export interface PrachtPluginOptions {
  /**
   * Switch off client-router features the app does not use, so they are
   * compiled out of the client bundle. See {@link PrachtClientOptions}.
   */
  client?: PrachtClientOptions;
  appFile?: string;
  routesDir?: string;
  shellsDir?: string;
  middlewareDir?: string;
  apiDir?: string;
  serverDir?: string;
  /**
   * Additional dot-prefixed route and shell module extensions to discover,
   * such as `[".vue"]`. Register the Vite plugin that transforms the format
   * separately; Pracht only discovers the modules and applies its route
   * client/server handling. Defaults to no additional extensions. `.tsrx`
   * remains discovered without configuration for backward compatibility.
   */
  additionalExtensions?: readonly string[];
  /**
   * Directory containing island components hydrated on
   * `hydration: "islands"` routes. Defaults to "/src/islands".
   */
  islandsDir?: string;
  /**
   * Directory containing capability modules registered in the app manifest
   * via `capabilities: { ... }`. Defaults to "/src/capabilities".
   */
  capabilitiesDir?: string;
  adapter?: PrachtAdapter;
  /** Enable file-system pages routing by pointing to the pages directory (e.g. "/src/pages"). */
  pagesDir?: string;
  /** Default render mode for pages when RENDER_MODE is not exported. Defaults to "ssr". */
  pagesDefaultRender?: RenderMode;
  /** Maximum number of SSG/ISG pages rendered concurrently during `pracht build`. */
  prerenderConcurrency?: number;
  /** Maximum request body size (bytes) accepted by the dev SSR middleware. Defaults to 1 MiB. */
  maxBodySize?: number;
  /**
   * Per-route gzip client-JS budgets evaluated by `pracht build`, e.g.
   * `{ "*": "120kb", "/dashboard": "200kb" }`. `"*"` applies to every route;
   * explicit route paths override it. Values are byte counts or size strings
   * ("120kb", "1mb"). Exceeded budgets fail the build unless
   * `pracht build --no-budget-fail` is used.
   */
  budgets?: Record<string, string | number>;
  /**
   * Opt into precompiling safe Preact JSX DOM subtrees for SSR/SSG server bundles.
   * Client bundles keep the normal Preact JSX transform for hydration.
   */
  precompileSsrJsx?: boolean | PreactSsrPrecompileOptions;
  /**
   * Client-bundle env leak detection. Enabled by default: production client
   * chunks referencing `process.env.X` / `import.meta.env.X` for a non-public
   * variable fail the build. Pass `{ allow: ["NAME"] }` to permit specific
   * variables, or `false` to disable the check entirely.
   */
  envSafety?: false | EnvSafetyOptions;
  /**
   * Opt into emitting an llms.txt file (https://llmstxt.org) generated from
   * the resolved app graph. `pracht build` writes `dist/client/llms.txt` and
   * the dev server serves `/llms.txt` live. Disabled by default.
   */
  llmsTxt?: false | PrachtLlmsTxtOptions;
}

export type ResolvedPrachtPluginOptions = Required<PrachtPluginOptions>;

export const CLIENT_FEATURE_DEFAULTS: Required<PrachtClientOptions> = {
  prefetch: true,
};

const DEFAULTS: ResolvedPrachtPluginOptions = {
  client: CLIENT_FEATURE_DEFAULTS,
  appFile: "/src/routes.ts",
  middlewareDir: "/src/middleware",
  routesDir: "/src/routes",
  shellsDir: "/src/shells",
  apiDir: "/src/api",
  serverDir: "/src/server",
  additionalExtensions: [],
  islandsDir: "/src/islands",
  capabilitiesDir: "/src/capabilities",
  adapter: createDefaultNodeAdapter(),
  pagesDir: "",
  pagesDefaultRender: "ssr",
  prerenderConcurrency: 10,
  maxBodySize: 1024 * 1024,
  budgets: {},
  precompileSsrJsx: false,
  envSafety: {},
  llmsTxt: false,
};

export function resolveOptions(options: PrachtPluginOptions): ResolvedPrachtPluginOptions {
  const resolved = {
    ...DEFAULTS,
    ...options,
  };
  // An explicit `llmsTxt: undefined` (permitted by the optional type) would
  // spread over the `false` default — treat it as disabled, not invalid.
  if (resolved.llmsTxt === undefined) {
    resolved.llmsTxt = false;
  }
  resolved.client = resolveClientOptions(options.client);
  resolved.additionalExtensions = normalizeAdditionalExtensions(resolved.additionalExtensions);
  if (!new Set(["spa", "ssr", "ssg", "isg"]).has(resolved.pagesDefaultRender)) {
    throw new Error('pracht({ pagesDefaultRender }) expects "spa", "ssr", "ssg", or "isg".');
  }
  if (!Number.isInteger(resolved.prerenderConcurrency) || resolved.prerenderConcurrency <= 0) {
    throw new Error("pracht({ prerenderConcurrency }) expects a positive integer.");
  }
  if (!Number.isInteger(resolved.maxBodySize) || resolved.maxBodySize <= 0) {
    throw new Error("pracht({ maxBodySize }) expects a positive integer number of bytes.");
  }
  validateBudgets(resolved.budgets);
  validateLlmsTxt(resolved.llmsTxt);
  return resolved;
}

function resolveClientOptions(
  client: PrachtClientOptions | undefined,
): Required<PrachtClientOptions> {
  if (client === undefined) return CLIENT_FEATURE_DEFAULTS;
  if (typeof client !== "object" || client === null) {
    throw new Error("pracht({ client }) expects an options object.");
  }
  const resolved = { ...CLIENT_FEATURE_DEFAULTS };
  for (const key of Object.keys(CLIENT_FEATURE_DEFAULTS) as Array<keyof PrachtClientOptions>) {
    const value = client[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") {
      throw new Error(
        `pracht({ client: { ${key} } }) expects a boolean, got ${JSON.stringify(value)}.`,
      );
    }
    resolved[key] = value;
  }
  const unknown = Object.keys(client).filter((key) => !(key in CLIENT_FEATURE_DEFAULTS));
  if (unknown.length > 0) {
    throw new Error(
      `pracht({ client }) does not accept ${unknown.map((key) => JSON.stringify(key)).join(", ")}. ` +
        `Known features: ${Object.keys(CLIENT_FEATURE_DEFAULTS).join(", ")}.`,
    );
  }
  return resolved;
}

const LLMS_TXT_SECTIONS = new Set<LlmsTxtSection>(["pages", "api", "capabilities"]);

function validateLlmsTxt(llmsTxt: false | PrachtLlmsTxtOptions): void {
  if (llmsTxt === false) return;
  if (typeof llmsTxt !== "object" || llmsTxt === null) {
    throw new Error("pracht({ llmsTxt }) expects false or an options object.");
  }
  if (llmsTxt.include !== undefined) {
    const isValid =
      Array.isArray(llmsTxt.include) &&
      llmsTxt.include.every((section) => LLMS_TXT_SECTIONS.has(section));
    if (!isValid) {
      throw new Error(
        `pracht({ llmsTxt: { include } }) expects an array of "pages", "api", and/or "capabilities", got ${JSON.stringify(llmsTxt.include)}.`,
      );
    }
  }
}

function validateBudgets(budgets: Record<string, string | number>): void {
  for (const [key, value] of Object.entries(budgets)) {
    if (key !== "*" && !key.startsWith("/")) {
      throw new Error(
        `pracht({ budgets }) keys must be "*" or a route path starting with "/", got ${JSON.stringify(key)}.`,
      );
    }
    const isValidNumber = typeof value === "number" && Number.isFinite(value) && value > 0;
    const isValidString = typeof value === "string" && value.trim().length > 0;
    if (!isValidNumber && !isValidString) {
      throw new Error(
        `pracht({ budgets }) values must be a positive number of bytes or a size string like "120kb", got ${JSON.stringify(value)} for ${JSON.stringify(key)}.`,
      );
    }
  }
}
