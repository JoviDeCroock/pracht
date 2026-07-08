import { useState } from "preact/hooks";

export function Component() {
  const [clicked, setClicked] = useState(false);

  return (
    <section>
      <h1>Full hydration</h1>
      <p>This route hydrates the whole page tree, like any regular pracht route.</p>
      <button type="button" data-testid="full-button" onClick={() => setClicked(true)}>
        {clicked ? "hydrated" : "click me"}
      </button>
    </section>
  );
}
