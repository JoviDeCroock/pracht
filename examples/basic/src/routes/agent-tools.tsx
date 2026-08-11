export function head() {
  return { title: "Agent tools" };
}

export function Component() {
  return (
    <main>
      <h1>Agent tools without UI islands</h1>
      <p>
        This server-rendered page has no interactive island components, while the app-level WebMCP
        projection remains available to browser agents.
      </p>
    </main>
  );
}
