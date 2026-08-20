const WIDGETS = ["Deploys", "Traffic", "Errors"];

export function Component() {
  return (
    <section id="dashboard">
      <h1>Dashboard</h1>
      <p>Rendered entirely in the browser without a Pracht loader.</p>
      <ul>
        {WIDGETS.map((widget) => (
          <li key={widget}>{widget}</li>
        ))}
      </ul>
      <a href="/items/42">Open item 42</a>
    </section>
  );
}
