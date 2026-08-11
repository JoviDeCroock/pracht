export function head() {
  return { title: "About — Pracht Static Example" };
}

/**
 * Document headers a route exports are replayed by the host configuration the
 * static build writes (`_headers` on Netlify, `config.json` on Vercel) — the
 * framework is not there to apply them.
 */
export function headers() {
  return { "x-pracht-example": "about" };
}

export function Component() {
  return (
    <section>
      <h1 data-testid="about">Zero JavaScript</h1>
      <p>
        This page uses <code>hydration: "none"</code>, so the build ships HTML and CSS and nothing
        else. Links leave through a normal document navigation.
      </p>
    </section>
  );
}
