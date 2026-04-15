import type { ShellProps } from "@pracht/core";

export function Shell({ children }: ShellProps) {
  return (
    <div class="app-layout">
      <aside class="sidebar">
        <strong class="sidebar-logo">Launchpad</strong>
        <nav>
          <a href="/app">Dashboard</a>
          <a href="/app/settings">Settings</a>
        </nav>
        <a href="/" class="sidebar-back">
          Back to site
        </a>
      </aside>
      <main class="app-main">{children}</main>
    </div>
  );
}

export function Loading() {
  return (
    <section aria-busy="true" class="loading-state">
      <p>Loading...</p>
    </section>
  );
}

export function head() {
  return {
    title: "Launchpad — App",
  };
}

export function headers() {
  return {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
}
