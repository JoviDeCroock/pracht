import { h } from "preact";
import { useState } from "preact/hooks";

// A component written without JSX, in a plain `.ts` file.
export function Legacy() {
  const [count, setCount] = useState(0);
  return h("button", { onClick: () => setCount(count + 1) }, `legacy ${count}`);
}
