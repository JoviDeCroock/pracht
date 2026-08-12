import type { LoaderArgs, RouteComponentProps } from "@pracht/core";

export async function loader(_args: LoaderArgs) {
  return { widgets: ["Deploys", "Traffic", "Errors"] };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  return (
    <section id="dashboard">
      <h1>Dashboard</h1>
      <p>Rendered entirely in the browser from build-time data.</p>
      <ul>
        {data.widgets.map((widget) => (
          <li key={widget}>{widget}</li>
        ))}
      </ul>
      <a href="/items/42">Open item 42</a>
    </section>
  );
}
