import { useState } from "preact/hooks";
import type { IslandProps } from "@pracht/core";
import "../styles.css";
import "./counter.css";
import { Card } from "../components/Card.tsx";

interface CounterProps {
  start?: number;
}

export default function Counter({ start = 0 }: CounterProps & IslandProps) {
  const [count, setCount] = useState(start);

  return (
    <div class="counter">
      <Card label="shared with a static route" />
      <p data-testid="count">Count: {count}</p>
      <button type="button" data-testid="increment" onClick={() => setCount((c) => c + 1)}>
        Increment
      </button>
    </div>
  );
}
