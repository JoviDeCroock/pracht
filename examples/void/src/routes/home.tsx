import type { RouteComponentProps } from "@pracht/core";

export function loader() {
  return {
    checks: ["Pracht routing", "Void deploy output", "Void binding helpers"],
  };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  return (
    <section>
      <h1>Void deploy target</h1>
      <ul>
        {data.checks.map((check) => (
          <li key={check}>{check}</li>
        ))}
      </ul>
    </section>
  );
}
