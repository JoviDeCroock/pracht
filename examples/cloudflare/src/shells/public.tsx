import type { ShellProps } from "previte";

export function Shell({ children }: ShellProps) {
  return (
    <div class="public-shell">
      <header>
        <strong>Previte</strong>
        <nav>
          <a href="/">Home</a>
          <a href="/pricing">Pricing</a>
        </nav>
      </header>
      <main>{children}</main>
      <footer>Preact-first. Vite-native. Explicit routing.</footer>
    </div>
  );
}

export function head() {
  return {
    meta: [{ content: "width=device-width, initial-scale=1", name: "viewport" }],
    title: "Previte Example",
  };
}
