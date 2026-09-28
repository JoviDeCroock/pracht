import { useShellData, type LoaderArgs, type ShellProps } from "@pracht/core";

import type { SessionContext } from "../server/session.ts";

// The signed-in user every page in this shell shows. The `auth` middleware has
// already refused anonymous requests; this runs beside the route loader, and
// navigations between `/dashboard` and `/settings` reuse its result.
export async function loader({ context }: LoaderArgs<SessionContext>) {
  return { name: context.session.get("name") ?? "Guest" };
}

export function Shell({ children }: ShellProps) {
  const shell = useShellData<typeof loader>();

  return (
    <div class="app-shell">
      <aside>
        <nav>
          <a href="/dashboard">Dashboard</a>
          <a href="/settings">Settings</a>
          <a href="/">Back to home</a>
        </nav>
        {shell && <span class="shell-user">{shell.name}</span>}
      </aside>
      <main>{children}</main>
    </div>
  );
}

export function Loading() {
  return (
    <section aria-busy="true">
      <p>Loading page...</p>
    </section>
  );
}

export function head() {
  return {
    title: "Pracht App",
  };
}

export function headers() {
  return {
    "x-pracht-shell": "app",
  };
}
