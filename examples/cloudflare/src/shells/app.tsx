import { useShellData, type LoaderArgs, type ShellProps } from "@pracht/core";

// Layout-level data for every page in this shell. It runs beside the route
// loader, and client navigations that stay inside the shell reuse it instead
// of running it again. `loadId` changes each time the loader runs.
export async function loader({ request }: LoaderArgs) {
  const hasSession = request.headers.get("cookie")?.includes("session=") ?? false;

  return {
    loadId: crypto.randomUUID(),
    user: hasSession ? "Ada Lovelace" : "Guest",
  };
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
        <span class="shell-user">{shell?.user}</span>
        <small class="shell-load-id" hidden>
          {shell?.loadId}
        </small>
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
