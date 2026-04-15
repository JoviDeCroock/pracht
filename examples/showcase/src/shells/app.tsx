import type { ShellProps } from "@pracht/core";
import "../styles/global.css";

export function Shell({ children }: ShellProps) {
  return (
    <div class="app-layout">
      <aside class="sidebar">
        <div class="sidebar-logo">
          <span class="logo-mark" style="width:20px;height:20px;font-size:9px">
            L
          </span>
          Launchpad
        </div>
        <nav>
          <a href="/app">Dashboard</a>
          <a href="/app/settings">Settings</a>
        </nav>
        <a href="/api/auth/logout" class="sidebar-back">
          &larr; Sign out
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
  return { title: "Launchpad — App" };
}

export function headers() {
  return {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
}
