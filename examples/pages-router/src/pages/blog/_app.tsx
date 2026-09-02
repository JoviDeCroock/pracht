import type { ShellProps } from "@pracht/core";

// A directory-scoped shell: every route under `src/pages/blog/` renders in this
// one instead of the root `_app.tsx`. Nested shells replace rather than nest,
// exactly like a group's `shell` in an explicit manifest, so this file owns the
// whole chrome for the blog subtree.
export function Shell({ children }: ShellProps) {
  return (
    <div class="blog-shell">
      <header>
        <strong>Pracht Pages — Blog</strong>
        <nav>
          <a href="/">Home</a>
          <a href="/blog/getting-started">Getting Started</a>
        </nav>
      </header>
      <main>{children}</main>
      <footer>Directory-scoped shell from blog/_app.tsx.</footer>
    </div>
  );
}

export function head() {
  return {
    meta: [{ content: "width=device-width, initial-scale=1", name: "viewport" }],
    title: "Pracht Pages Blog",
  };
}
