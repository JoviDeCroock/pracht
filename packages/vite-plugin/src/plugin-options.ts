import type { RenderMode } from "@pracht/core";
import type { PreactSsrPrecompileOptions } from "@pracht/preact-ssr-precompile";
import { createDefaultNodeAdapter, type PrachtAdapter } from "./plugin-adapter.ts";

export type LlmsTxtSection = "pages" | "api";

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
  /** Sections to emit. Defaults to ["pages", "api"]. */
  include?: LlmsTxtSection[];
}

export interface PrachtPluginOptions {
  appFile?: string;
  routesDir?: string;
  shellsDir?: string;
  middlewareDir?: string;
  apiDir?: string;
  serverDir?: string;
  /**
   * Directory containing island components hydrated on
   * `hydration: "islands"` routes. Defaults to "/src/islands".
   */
  islandsDir?: string;
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
   * Opt into emitting an llms.txt file (https://llmstxt.org) generated from
   * the resolved app graph. `pracht build` writes `dist/client/llms.txt` and
   * the dev server serves `/llms.txt` live. Disabled by default.
   */
  llmsTxt?: false | PrachtLlmsTxtOptions;
}

export type ResolvedPrachtPluginOptions = Required<PrachtPluginOptions>;

const DEFAULTS: ResolvedPrachtPluginOptions = {
  appFile: "/src/routes.ts",
  middlewareDir: "/src/middleware",
  routesDir: "/src/routes",
  shellsDir: "/src/shells",
  apiDir: "/src/api",
  serverDir: "/src/server",
  islandsDir: "/src/islands",
  adapter: createDefaultNodeAdapter(),
  pagesDir: "",
  pagesDefaultRender: "ssr",
  prerenderConcurrency: 10,
  maxBodySize: 1024 * 1024,
  budgets: {},
  precompileSsrJsx: false,
  llmsTxt: false,
};

export function resolveOptions(options: PrachtPluginOptions): ResolvedPrachtPluginOptions {
  const resolved = {
    ...DEFAULTS,
    ...options,
  };
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

const LLMS_TXT_SECTIONS = new Set<LlmsTxtSection>(["pages", "api"]);

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
        `pracht({ llmsTxt: { include } }) expects an array of "pages" and/or "api", got ${JSON.stringify(llmsTxt.include)}.`,
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
