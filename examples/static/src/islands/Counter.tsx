import { useState } from "preact/hooks";
import type { IslandProps } from "@pracht/core";

export default function Counter({ start = 0 }: { start?: number } & IslandProps) {
  const [count, setCount] = useState(start);

  return (
    <div class="counter">
      <p data-testid="count">Count: {count}</p>
      <button type="button" data-testid="increment" onClick={() => setCount((value) => value + 1)}>
        Increment
      </button>
    </div>
  );
}
