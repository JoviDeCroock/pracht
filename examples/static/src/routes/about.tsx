import type { LoaderArgs, RouteComponentProps } from "@pracht/core";

export async function loader(_args: LoaderArgs) {
  return { builtAt: "Build time", team: ["Ada", "Grace", "Edsger"] };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  return (
    <section id="about">
      <h1>About</h1>
      <p id="built-at">Data generated at: {data.builtAt}</p>
      <ul>
        {data.team.map((name) => (
          <li key={name}>{name}</li>
        ))}
      </ul>
    </section>
  );
}
