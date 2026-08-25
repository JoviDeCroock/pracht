import { useState } from "preact/hooks";

// A co-located loader is the documented default authoring style, and it is
// what makes the client variant of this module distinct from the authored one.
export async function loader() {
  return { greeting: "hello" };
}

export function head() {
  return { title: "home" };
}

export function Component() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(count + 1)}>{count}</button>;
}
