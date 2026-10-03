import { useLocation, type LoaderArgs, type RouteComponentProps } from "@pracht/core";

export async function loader(_args: LoaderArgs) {
  return {
    builtAt: "Build time",
    team: ["Ada", "Grace", "Edsger"],
    // Rich values survive the prerendered HTML and the static route-state file.
    foundedAt: new Date("1843-07-01T00:00:00.000Z"),
    roles: new Map([
      ["Ada", "analyst"],
      ["Grace", "compiler"],
    ]),
  };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  const location = useLocation();

  return (
    <section id="about">
      <h1>About</h1>
      <p id="about-path">Served from: {location.pathname}</p>
      <p id="built-at">Data generated at: {data.builtAt}</p>
      <p id="founded">
        Founded {data.foundedAt.getUTCFullYear()}; Ada is the {data.roles.get("Ada")}
      </p>
      <ul>
        {data.team.map((name) => (
          <li key={name}>{name}</li>
        ))}
      </ul>
    </section>
  );
}
