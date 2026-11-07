import type { IslandProps } from "@pracht/core";
import { useEffect, useRef, useState } from "preact/hooks";

const ORIGIN = "https://pracht.resynapse.dev";
const MCP_COMMAND = `claude mcp add --transport http pracht-docs ${ORIGIN}/mcp`;

interface PageActionsProps {
  /** The page path, e.g. `/docs/routing`. */
  path: string;
  title: string;
}

function prompt(path: string): string {
  return `Read ${ORIGIN}${path}.md and help me with pracht. Answer from that page and the docs it links to.`;
}

/**
 * "Copy page" plus a menu of agent hand-offs. The menu is a `<details>`, so
 * it opens without JavaScript; hydration adds copying and outside-click close.
 */
export default function PageActions({ path, title }: PageActionsProps & IslandProps) {
  const menu = useRef<HTMLDetailsElement>(null);
  const [copied, setCopied] = useState<"" | "page" | "mcp" | "error">("");

  useEffect(() => {
    const close = (event: Event) => {
      if (menu.current?.open && !menu.current.contains(event.target as Node)) {
        menu.current.open = false;
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && menu.current?.open) {
        menu.current.open = false;
        menu.current.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("click", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", escape);
    };
  }, []);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(""), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copyPage = async () => {
    try {
      const response = await fetch(`${path}.md`);
      if (!response.ok) throw new Error(String(response.status));
      await navigator.clipboard.writeText(await response.text());
      setCopied("page");
    } catch {
      setCopied("error");
    }
  };

  const copyMcp = async () => {
    try {
      await navigator.clipboard.writeText(MCP_COMMAND);
      setCopied("mcp");
    } catch {
      setCopied("error");
    }
    if (menu.current) menu.current.open = false;
  };

  const query = encodeURIComponent(prompt(path));

  return (
    <div class="page-actions">
      <button
        type="button"
        class="page-action"
        onClick={copyPage}
        title={`Copy ${title} as Markdown`}
      >
        {copied === "page" ? "Copied" : copied === "error" ? "Copy failed" : "Copy page"}
      </button>
      <span class="sr-only" role="status">
        {copied === "page"
          ? `${title} copied as Markdown`
          : copied === "mcp"
            ? "MCP install command copied"
            : copied === "error"
              ? "Copy failed"
              : ""}
      </span>
      <details ref={menu} class="page-actions-menu">
        <summary class="page-action" aria-label="More page actions">
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
            <path
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              d="m6 9 6 6 6-6"
            />
          </svg>
        </summary>
        <ul class="page-actions-list">
          <li>
            <a href={`${path}.md`}>
              <strong>View as Markdown</strong>
              <span>The plain-text page for agents</span>
            </a>
          </li>
          <li>
            <a href={`https://chatgpt.com/?hints=search&q=${query}`} target="_blank" rel="noopener">
              <strong>Open in ChatGPT</strong>
              <span>Ask questions about this page</span>
            </a>
          </li>
          <li>
            <a href={`https://claude.ai/new?q=${query}`} target="_blank" rel="noopener">
              <strong>Open in Claude</strong>
              <span>Ask questions about this page</span>
            </a>
          </li>
          <li>
            <button type="button" onClick={copyMcp}>
              <strong>{copied === "mcp" ? "Copied" : "Copy MCP install command"}</strong>
              <span>Search these docs from Claude Code</span>
            </button>
          </li>
        </ul>
      </details>
    </div>
  );
}
