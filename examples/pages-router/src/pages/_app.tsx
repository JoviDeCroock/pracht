import type { ShellProps } from "@pracht/core";

export function Shell({ children }: ShellProps) {
  return (
    <div class="pages-shell">
      <header>
        <strong>Pracht Pages</strong>
        <nav>
          <a href="/">Home</a>
          <a href="/about">About</a>
          <a href="/blog/hello-world">Blog</a>
          <a href="/api/health">API: Health</a>
          <a href="/api/me">API: Me (auth)</a>
        </nav>
      </header>
      <main>{children}</main>
      <footer>File-system routing powered by pracht.</footer>
    </div>
  );
}

export function head() {
  return {
    meta: [{ content: "width=device-width, initial-scale=1", name: "viewport" }],
    title: "Pracht Pages Router",
  };
}

export function headers() {
  return {
    "x-pracht-router": "pages",
  };
}
