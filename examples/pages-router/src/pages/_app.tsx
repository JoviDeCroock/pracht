import type { ShellProps } from "previte";

export function Shell({ children }: ShellProps) {
  return (
    <div class="pages-shell">
      <header>
        <strong>Previte Pages</strong>
        <nav>
          <a href="/">Home</a>
          <a href="/about">About</a>
          <a href="/blog/hello-world">Blog</a>
        </nav>
      </header>
      <main>{children}</main>
      <footer>File-system routing powered by previte.</footer>
    </div>
  );
}

export function head() {
  return {
    meta: [{ content: "width=device-width, initial-scale=1", name: "viewport" }],
    title: "Previte Pages Router",
  };
}
