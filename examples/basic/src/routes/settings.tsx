import type { LoaderArgs, RouteComponentProps } from "previte";

export async function loader(_args: LoaderArgs) {
  return {
    sections: ["Profile", "Notifications", "Teams"],
  };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  return (
    <section>
      <h1>Settings</h1>
      <p>This route is marked as SPA in the manifest.</p>
      <ul>
        {data.sections.map((section) => (
          <li key={section}>{section}</li>
        ))}
      </ul>
    </section>
  );
}
