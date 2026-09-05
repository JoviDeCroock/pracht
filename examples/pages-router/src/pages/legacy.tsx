// `_middleware.ts` redirects this route to /about before it ever renders —
// the Next.js-style "legacy URL" middleware pattern.
export function Component() {
  return (
    <section>
      <h1>Legacy</h1>
      <p>This page is never reached: middleware redirects it to /about.</p>
    </section>
  );
}
