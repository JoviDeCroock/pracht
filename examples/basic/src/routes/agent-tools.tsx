export function head() {
  return { title: "Agent tools" };
}

export function Component() {
  return (
    <main>
      <h1>Agent tools without UI islands</h1>
      <p>
        This server-rendered page has no interactive island components, while its route-scoped
        WebMCP tools remain available to browser agents.
      </p>
    </main>
  );
}
