export function Component() {
  return (
    <section>
      <h1>Fully static</h1>
      <p>
        This page uses <code>hydration: "none"</code> — no JavaScript is injected at all.
      </p>
    </section>
  );
}
