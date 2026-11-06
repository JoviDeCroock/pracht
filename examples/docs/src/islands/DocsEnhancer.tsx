import type { IslandProps } from "@pracht/core";
import { useEffect } from "preact/hooks";

/**
 * Behaviour for the static page markup the Markdown compiler emits: the copy
 * buttons in code block headers and the "On this page" highlight. Renders
 * nothing; without JavaScript the buttons are inert and the rail still links.
 */
export default function DocsEnhancer(_props: IslandProps) {
  useEffect(() => {
    // Keep the current page visible in a long sidebar.
    const sidebar = document.querySelector<HTMLElement>(".docs-sidebar");
    const current = sidebar?.querySelector<HTMLElement>('[aria-current="page"]');
    if (sidebar && current) {
      const top =
        current.getBoundingClientRect().top -
        sidebar.getBoundingClientRect().top +
        sidebar.scrollTop;
      if (top > sidebar.clientHeight - 80) sidebar.scrollTop = top - sidebar.clientHeight / 3;
    }

    // Copy buttons change their own text, which screen readers do not
    // announce; this status region does.
    const status = document.createElement("div");
    status.className = "sr-only";
    status.setAttribute("role", "status");
    document.body.append(status);

    const onClick = async (event: MouseEvent) => {
      const button = (event.target as Element | null)?.closest<HTMLButtonElement>(".code-copy");
      if (!button) return;
      const code = button.closest(".code-block")?.querySelector("pre")?.textContent ?? "";
      try {
        await navigator.clipboard.writeText(code.replace(/\n$/, ""));
        button.textContent = "Copied";
        status.textContent = "Code copied";
      } catch {
        button.textContent = "Failed";
        status.textContent = "Copy failed";
      }
      setTimeout(() => (button.textContent = "Copy"), 1600);
    };
    document.addEventListener("click", onClick);

    const links = new Map<string, HTMLAnchorElement>();
    for (const link of document.querySelectorAll<HTMLAnchorElement>(".doc-toc a")) {
      links.set(decodeURIComponent(link.hash.slice(1)), link);
    }
    let observer: IntersectionObserver | undefined;
    if (links.size > 0 && "IntersectionObserver" in window) {
      const headings = [...links.keys()]
        .map((id) => document.getElementById(id))
        .filter((heading): heading is HTMLElement => heading !== null);
      const visible = new Set<Element>();
      const mark = () => {
        // The first heading on screen; once the reader scrolls past every
        // heading, the last one they passed.
        let current = headings.find((heading) => visible.has(heading));
        if (!current) {
          current = headings.filter((heading) => heading.getBoundingClientRect().top < 80).pop();
        }
        for (const [id, link] of links) {
          if (current && id === current.id) link.setAttribute("aria-current", "true");
          else link.removeAttribute("aria-current");
        }
      };
      observer = new IntersectionObserver(
        (records) => {
          for (const record of records) {
            if (record.isIntersecting) visible.add(record.target);
            else visible.delete(record.target);
          }
          mark();
        },
        { rootMargin: "-64px 0px -55% 0px" },
      );
      for (const heading of headings) observer.observe(heading);
    }

    return () => {
      document.removeEventListener("click", onClick);
      observer?.disconnect();
      status.remove();
    };
  }, []);

  return null;
}
