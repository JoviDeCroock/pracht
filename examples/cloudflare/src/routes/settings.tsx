import { useShellData, type LoaderArgs, type RouteComponentProps } from "@pracht/core";

import type { loader as appShellLoader } from "../shells/app.tsx";

export async function loader(_args: LoaderArgs) {
  return {
    sections: ["Profile", "Notifications", "Teams"],
  };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  // Routes read their shell's data too, without loading it themselves.
  const shell = useShellData<typeof appShellLoader>();

  return (
    <section>
      <h1>Settings</h1>
      <span class="route-shell-user">Signed in as {shell?.user}</span>
      <p>This route is marked as SPA in the manifest.</p>
      <ul>
        {data.sections.map((section) => (
          <li key={section}>{section}</li>
        ))}
      </ul>
    </section>
  );
}
