/**
 * The streamed-document gate.
 *
 * On Preact 11 a streamed document starts its client entry right after the
 * shell, so the shell hydrates while boundaries are still arriving. A boundary
 * that suspended during that pass resumes by re-scanning the DOM between its
 * `$s` markers, and the renderer swaps a boundary's markup into that range in
 * an animation frame. Resuming before the swap hydrates resolved content
 * against the fallback. Holding every resume until the document has finished
 * parsing and the swaps queued by then have run closes that window without
 * knowing which boundary a deferred value or lazy import belongs to.
 */

let gate: Promise<void> | undefined;
let open = false;

/**
 * A promise that settles once the streamed document is complete, or
 * `undefined` when it already is. Callers keep their synchronous path for
 * `undefined`, so buffered documents and an entry at the end of a streamed one
 * behave exactly as before.
 */
export function whenDocumentStreamed(): Promise<void> | undefined {
  if (open || typeof document === "undefined") return undefined;
  if (!gate) {
    if (document.readyState !== "loading") return undefined;
    gate = new Promise<void>((resolve) => {
      document.addEventListener(
        "DOMContentLoaded",
        // Every boundary swap was requested in an earlier frame callback than
        // this one, so they have all run when it fires.
        () =>
          requestAnimationFrame(() => {
            open = true;
            resolve();
          }),
        { once: true },
      );
    });
  }
  return gate;
}
