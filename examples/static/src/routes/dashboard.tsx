import { useEffect, useState } from "preact/hooks";

/**
 * A SPA route has no server behind it here, so it fetches its own data in the
 * browser. The build only writes the shell and its `Loading()` placeholder.
 */
export function Component() {
  const [items, setItems] = useState<string[] | null>(null);

  useEffect(() => {
    // Stands in for a call to an external API.
    const timer = setTimeout(() => setItems(["alpha", "beta", "gamma"]), 0);
    return () => clearTimeout(timer);
  }, []);

  return (
    <section>
      <h1 data-testid="dashboard">Dashboard</h1>
      {items === null ? (
        <p>Fetching…</p>
      ) : (
        <ul data-testid="items">
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
