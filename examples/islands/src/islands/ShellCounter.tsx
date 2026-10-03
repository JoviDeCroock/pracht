import { useState } from "preact/hooks";

// Lives in the guide shell, so it is on every guide page. With
// `client.islandsNavigation` its element is carried across page changes and
// the count survives; without it, every link starts it over.
export default function ShellCounter() {
  const [count, setCount] = useState(0);

  return (
    <button type="button" data-testid="shell-increment" onClick={() => setCount((c) => c + 1)}>
      Shell clicks: <span data-testid="shell-count">{count}</span>
    </button>
  );
}
