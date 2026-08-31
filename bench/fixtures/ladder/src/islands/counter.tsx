import type { IslandProps } from "@pracht/core";

import { Counter } from "../counter.tsx";

export default function CounterIsland({ start = 0 }: { start?: number } & IslandProps) {
  return <Counter start={start} />;
}
