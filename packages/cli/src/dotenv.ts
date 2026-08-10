import { loadEnv } from "vite";

/**
 * Load `.env` files into `process.env` for the local dev server.
 *
 * Vite reads `.env` files, but only exposes prefixed keys through
 * `import.meta.env` — it never writes them to `process.env`. Server-side code
 * reads `process.env` (that is what `serverEnv` resolves to on Node and
 * Vercel), so an unprefixed secret in `.env` was simply invisible: a
 * `PRACHT_CONFIRMATION_SECRET` sitting in the file the user just created had no
 * effect, and the destructive-capability gate failed closed with
 * `confirmation_unavailable`.
 *
 * Wrangler already does this for Cloudflare apps ("Using secrets defined in
 * .env"), so the same project behaved differently per adapter.
 *
 * Real environment variables always win over the file, matching Vite, wrangler,
 * and dotenv. `.env.local` beats `.env.<mode>` beats `.env`, which `loadEnv`
 * already implements.
 *
 * `mode` is required rather than derived from `NODE_ENV`: Vite's dev server is
 * always mode `development` whatever `NODE_ENV` says, and guessing wrong would
 * load `.env.production` into a dev server.
 */
export function loadDotEnvIntoProcess(root: string, mode: string): string[] {
  // An empty prefix asks Vite for every key in the `.env` files, not just the
  // client-exposed ones — this is the server-side environment.
  const fileEnv = loadEnv(mode, root, "");
  const applied: string[] = [];

  for (const [key, value] of Object.entries(fileEnv)) {
    // Vite refuses `NODE_ENV=production` from a `.env` file on purpose, and
    // only honours `NODE_ENV=development`. Assigning it here would run ahead of
    // that guard and silently flip the dev server into production mode.
    if (key === "NODE_ENV") continue;
    if (key in process.env) continue;
    process.env[key] = value;
    applied.push(key);
  }

  return applied;
}
