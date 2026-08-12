import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const FALLBACK_VERSION_RANGES = {
  "@pracht/adapter-cloudflare": "^0.5.8",
  "@pracht/adapter-netlify": "^0.1.0",
  "@pracht/adapter-node": "^0.3.8",
  "@pracht/adapter-vercel": "^0.2.8",
  "@pracht/cli": "^1.9.0",
  "@pracht/core": "^0.12.0",
  "@pracht/vite-plugin": "^0.7.6",
  "@tailwindcss/vite": "^4.1.0",
  "netlify-cli": "^21.6.0",
  tailwindcss: "^4.1.0",
  typescript: "^6.0.0",
  vercel: "^56.5.0",
};

/**
 * Cloudflare `compatibility_date` for scaffolded apps.
 *
 * This has to be a date the installed workerd already knows about — workerd
 * refuses to start when asked for a date newer than the one its binary was
 * built with ("This Worker requires compatibility date X, but the newest date
 * supported by this server binary is Y"). Using today's date is therefore
 * always wrong: it is, by construction, at or beyond the newest released
 * workerd, so a freshly scaffolded app could not run `wrangler dev` on the day
 * it was created.
 *
 * Keep it at or below the ceiling of the oldest wrangler this scaffold accepts
 * (see `devDependencies.wrangler` in scaffold.js). That ceiling is *not* the
 * workerd version date — it usually runs a little ahead of it — so check it
 * rather than infer it: install that wrangler and start a worker with a
 * candidate date; the error message names the newest date the binary supports.
 *
 * `packages/start/test/index.test.js` fails once this drifts too far behind, so
 * a new app never silently opts out of years of default-on runtime behaviour.
 */
export const WRANGLER_COMPATIBILITY_DATE = "2026-04-06";

export const ADAPTERS = {
  node: {
    description: "Node.js server with a generated server entry",
    id: "node",
    label: "Node.js",
    packageName: "@pracht/adapter-node",
    short: "node",
  },
  cloudflare: {
    description: "Cloudflare Workers with wrangler deploy",
    id: "cloudflare",
    label: "Cloudflare Workers",
    packageName: "@pracht/adapter-cloudflare",
    short: "cf",
  },
  netlify: {
    description: "Netlify Functions with durable CDN caching",
    id: "netlify",
    label: "Netlify",
    packageName: "@pracht/adapter-netlify",
    short: "netlify",
  },
  vercel: {
    description: "Vercel Edge Functions with prebuilt deploy",
    id: "vercel",
    label: "Vercel",
    packageName: "@pracht/adapter-vercel",
    short: "vercel",
  },
};

export const DEFAULT_DIRECTORY = "pracht-app";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

// The published package bundles a copy of the repo skills; inside the
// monorepo, scaffold generation falls back to the source catalog.
export const SKILL_DIRS = [resolve(PACKAGE_ROOT, "skills"), resolve(PACKAGE_ROOT, "../../skills")];
