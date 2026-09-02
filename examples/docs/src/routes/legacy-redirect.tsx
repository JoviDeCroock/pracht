import { redirect, type LoaderArgs } from "@pracht/core";

/**
 * The docs "Agents" section used to be eight pages. It is four now:
 * /docs/agents, /docs/capabilities, /docs/agent-trust, /docs/coding-agents.
 *
 * The five retired URLs stay routable and answer a redirect so existing links,
 * bookmarks, and anything an agent recorded from an older `llms.txt` still
 * land on the page that absorbed the content. One module serves all of them;
 * the target is chosen from the request path.
 *
 * A browser re-applies the original `#anchor` when the redirect's `Location`
 * carries none, so a fragment survives the hop — but only lands somewhere if
 * the target page still has that heading. Two were worth preserving deliberately
 * because other pages linked them: `#destructive-tools` and
 * `#oauth-letting-a-real-host-connect`, both kept verbatim on
 * `/docs/capabilities`. Every other old fragment has no counterpart on the page
 * that absorbed it and simply lands at the top, which is the intended outcome —
 * the surrounding content moved, so a stale anchor has nothing to point at.
 *
 * These routes are excluded from `sitemap.xml` (see `vite-plugin-sitemap.ts`)
 * and never enter `llms.txt`, which is generated from the Markdown collection
 * and so only ever sees real `.md` pages.
 */
const TARGETS: Record<string, string> = {
  "/docs/llms": "/docs/agents",
  "/docs/agent-workflow": "/docs/coding-agents",
  "/docs/agent-skills": "/docs/coding-agents",
  "/docs/mcp": "/docs/coding-agents",
  "/docs/remote-mcp": "/docs/capabilities",
};

export async function loader({ request, url }: LoaderArgs) {
  const target = TARGETS[url.pathname.replace(/\/+$/, "")] ?? "/docs";
  // `return` rather than `throw`: nothing upstream needs to add headers, and a
  // returned Response is the plainer contract for a loader that only redirects.
  return redirect(target, { request, status: 308 });
}

export function Component() {
  // Never rendered — the loader always redirects.
  return null;
}
