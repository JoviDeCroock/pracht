/**
 * The generated server module's startup check, held here instead of awaited at
 * the module's top level. Vercel bundles an edge function to CommonJS, which
 * cannot express a top-level `await`, so the module registers the pending check
 * and every consumer waits on it: `handlePrachtRequest()` before serving,
 * `pracht build` before prerendering, and the Node entry before listening.
 */
let pending: Promise<void> | undefined;

/**
 * Register the server module's startup check and return it. A rejected check
 * stays registered, so every request fails with its error instead of being
 * served by a misconfigured app.
 */
export function setServerStartupCheck(check: Promise<void>): Promise<void> {
  pending = check;
  check.then(
    () => {
      if (pending === check) pending = undefined;
    },
    // Observed where it is awaited; without this an edge runtime reports the
    // rejection as unhandled before the first request arrives.
    () => {},
  );
  return check;
}

/** The registered startup check while it is pending or has failed. */
export function pendingServerStartupCheck(): Promise<void> | undefined {
  return pending;
}

/** Resolves once the registered startup check passes; rejects with its error. */
export async function serverStartupCheck(): Promise<void> {
  await pending;
}
