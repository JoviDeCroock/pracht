import type { ShellProps } from "previte";

export function Shell({ children }: ShellProps) {
  return (
    <div class="app-shell">
      <aside>
        <nav>
          <a href="/dashboard">Dashboard</a>
          <a href="/settings">Settings</a>
          <a href="/">Back to home</a>
        </nav>
      </aside>
      <main>{children}</main>
    </div>
  );
}

export function head() {
  return {
    title: "Previte App",
  };
}
