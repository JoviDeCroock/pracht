import { useState } from "preact/hooks";

/**
 * A regular server component with an onClick handler. On islands routes this
 * never hydrates — clicking it does nothing, proving non-island content ships
 * no JavaScript.
 */
export function DeadButton() {
  const [clicked, setClicked] = useState(false);

  return (
    <button type="button" data-testid="dead-button" onClick={() => setClicked(true)}>
      {clicked ? "hydrated" : "static"}
    </button>
  );
}
