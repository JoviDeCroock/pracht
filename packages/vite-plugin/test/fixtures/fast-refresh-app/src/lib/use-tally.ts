import { useState } from "preact/hooks";

// A custom hook in a plain `.ts` file: no JSX and no JSX runtime import.
export function useTally() {
  const [tally, setTally] = useState(0);
  return { tally, increment: () => setTally(tally + 1) };
}
