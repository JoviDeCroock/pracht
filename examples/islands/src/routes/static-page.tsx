import "./static-page.css";

export function Component() {
  return (
    <section class="static-hero">
      <h1>Fully static</h1>
      <p>
        This page uses <code>hydration: "none"</code> — no JavaScript is injected at all.
      </p>
    </section>
  );
}
