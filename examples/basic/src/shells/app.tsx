import type { ShellProps } from "@pracht/core";

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
