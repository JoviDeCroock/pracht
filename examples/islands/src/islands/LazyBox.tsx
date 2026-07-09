import { useState } from "preact/hooks";
import type { IslandProps } from "@pracht/core";

interface LazyBoxProps {
  label: string;
}

export function LazyBox({ label }: LazyBoxProps & IslandProps) {
  const [revealed, setRevealed] = useState(false);

  return (
    <div class="lazy-box">
      <button type="button" data-testid="reveal" onClick={() => setRevealed(true)}>
        {label}
      </button>
      {revealed ? <p data-testid="revealed">Hydrated below the fold!</p> : null}
    </div>
  );
}
