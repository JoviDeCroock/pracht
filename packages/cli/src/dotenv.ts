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
 * and dotenv. `.env.<mode>.local` beats `.env.<mode>`, which beats
 * `.env.local`, which beats `.env`; `loadEnv`
 * already implements.
 *
 * `mode` is required rather than derived from `NODE_ENV`: Vite's dev server is
 * always mode `development` whatever `NODE_ENV` says, and guessing wrong would
 * load `.env.production` into a dev server.
 */
export function loadDotEnvIntoProcess(root: string, mode: string): string[] {
  return createDotEnvSync(root, mode).load();
}

/**
 * The reloadable form of {@link loadDotEnvIntoProcess}, for a long-running dev
 * server. Each `load()` re-reads the files and brings the keys it owns — the
 * ones an earlier `load()` assigned — up to date: changed values are replaced
 * and keys removed from every file are deleted. Real environment variables
 * are never touched, and neither is a key the process reassigned itself after
 * it was loaded. Returns the keys this call assigned or updated.
 */
export function createDotEnvSync(root: string, mode: string): { load(): string[] } {
  const owned = new Map<string, string>();

  return {
    load() {
      for (const [key, value] of owned) {
        // Reassigned by the process since: no longer the file's to manage.
        if (process.env[key] !== value) owned.delete(key);
      }
      // `loadEnv` lets `process.env` override the files for every key matching
      // the prefix — with an empty prefix, every key. Hide the keys an earlier
      // load assigned for the duration of this synchronous call, or a reload
      // would read back its own stale values.
      for (const key of owned.keys()) delete process.env[key];
      let fileEnv: Record<string, string>;
      try {
        // An empty prefix asks Vite for every key in the `.env` files, not just
        // the client-exposed ones — this is the server-side environment.
        fileEnv = loadEnv(mode, root, "");
      } finally {
        for (const [key, value] of owned) process.env[key] = value;
      }
      const applied: string[] = [];

      for (const key of owned.keys()) {
        if (!Object.hasOwn(fileEnv, key)) {
          delete process.env[key];
          owned.delete(key);
        }
      }

      for (const [key, value] of Object.entries(fileEnv)) {
        // Vite refuses `NODE_ENV=production` from a `.env` file on purpose, and
        // only honours `NODE_ENV=development`. Assigning it here would run
        // ahead of that guard and silently flip the dev server into production
        // mode.
        if (key === "NODE_ENV") continue;
        if (owned.has(key)) {
          if (owned.get(key) === value) continue;
        } else if (key in process.env) {
          continue;
        }
        process.env[key] = value;
        owned.set(key, value);
        applied.push(key);
      }

      return applied;
    },
  };
}
