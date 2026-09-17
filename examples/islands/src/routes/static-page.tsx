// Imported straight into the markup rather than through a stylesheet. This
// route ships no JavaScript, so the module holding the URL never reaches the
// client bundle — the file it points at is emitted by the server build and has
// to travel out of it with the route's CSS.
import glyph from "../media/glyph.svg";

import "./static-page.css";

export function Component() {
  return (
    <section class="static-hero">
      <h1>Fully static</h1>
      <p>
        This page uses <code>hydration: "none"</code> — no JavaScript is injected at all.
      </p>
      <img alt="" height={96} id="static-glyph" src={glyph} width={96} />
    </section>
  );
}
