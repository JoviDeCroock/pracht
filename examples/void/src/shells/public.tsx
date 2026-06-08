import type { ShellProps } from "@pracht/core";

export function Shell({ children }: ShellProps) {
  return (
    <div class="void-shell">
      <header>
        <strong>Pracht on Void</strong>
        <nav>
          <a href="/">Home</a>
          <a href="/bindings">Bindings</a>
        </nav>
      </header>
      <main>{children}</main>
    </div>
  );
}

export function head() {
  return {
    meta: [{ content: "width=device-width, initial-scale=1", name: "viewport" }],
    title: "Pracht Void Example",
  };
}

export function headers() {
  return {
    "x-pracht-shell": "void-public",
  };
}
