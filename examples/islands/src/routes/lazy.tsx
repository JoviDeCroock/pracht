import { LazyBox } from "../islands/LazyBox.tsx";

export function Component() {
  return (
    <section>
      <h1>Lazy island</h1>
      <p>The island below the fold hydrates only once it scrolls into view.</p>
      <div style="height: 200vh" data-testid="spacer">
        Scroll down…
      </div>
      <LazyBox client="visible" label="Reveal" />
    </section>
  );
}
