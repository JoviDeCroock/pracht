const TOOLS = [
  {
    name: "projects.search",
    effect: "read",
    exposure: "http · webmcp · mcp",
    detail: "Find projects by name or summary. Safe to call freely.",
  },
  {
    name: "projects.create",
    effect: "write",
    exposure: "http · webmcp · mcp",
    detail: "Create a project. Rate limited per principal by named middleware.",
  },
  {
    name: "projects.deploy",
    effect: "write",
    exposure: "http · webmcp · mcp",
    detail: "Ship a build. Takes an idempotencyKey so retries do not double-deploy.",
  },
  {
    name: "projects.archive",
    effect: "destructive",
    exposure: "http only",
    detail: "Two-phase, and refused until a human approves the proposal.",
  },
  {
    name: "agent.whoami",
    effect: "read",
    exposure: "http · webmcp · mcp",
    detail: "Echoes the verified Web Bot Auth identity, or verified: false.",
  },
  {
    name: "agent.brief",
    effect: "read",
    exposure: "http · mcp",
    detail: "agentPolicy: require — verified agents only, on every transport.",
  },
];

const STRENGTHS = [
  {
    title: "The tool list is curated, not scraped",
    detail:
      "Six capabilities are registered in src/routes.ts. Nothing else in this app is reachable as a tool, however many routes and API endpoints it grows.",
  },
  {
    title: "The contract is the same one humans use",
    detail:
      "The dashboard's create form and an agent's POST hit one endpoint, one schema, one middleware chain. A rule cannot be enforced for one audience and skipped for the other.",
  },
  {
    title: "Identity is cryptographic",
    detail:
      "Sign with RFC 9421 and context.agent carries your verified key id. Fail any check — expiry, covered components, an untrusted keyid — and it is null, never partial.",
  },
  {
    title: "Consent is not something the caller can assert",
    detail:
      "A destructive call is refused until a person decides, out of band, in the application's own inbox. Holding the confirmation token is not approval.",
  },
];

/**
 * Markdown content negotiation: `curl -H "Accept: text/markdown" /agents`
 * returns this instead of the HTML document. Same canonical URL for people and
 * for tools.
 */
export const markdown = `# Launchpad — agent briefing

Launchpad is a demo project-management app built with Pracht. Its domain
operations are exposed as **capabilities**: typed, protocol-neutral operations
with one JSON Schema contract each.

## Discovery

- \`/llms.txt\` — generated from the resolved app graph: pages, API endpoints, and
  HTTP-exposed capabilities.
- \`POST /api/capabilities/agent/whoami\` — what identity the server established for you.
- \`POST /api/capabilities/agent/brief\` — house rules. Verified agents only.
- \`POST /mcp\` — the same capabilities as MCP tools over Streamable HTTP.

## Tools

| Capability | Effect | Exposure | Endpoint |
| --- | --- | --- | --- |
| \`projects.search\` | read | http, webmcp, mcp | \`POST /api/capabilities/projects/search\` |
| \`projects.create\` | write | http, webmcp, mcp | \`POST /api/capabilities/projects/create\` |
| \`projects.deploy\` | write | http, webmcp, mcp | \`POST /api/capabilities/projects/deploy\` |
| \`projects.archive\` | destructive | http only | \`POST /api/capabilities/projects/archive\` |
| \`agent.whoami\` | read | http, webmcp, mcp | \`POST /api/capabilities/agent/whoami\` |
| \`agent.brief\` | read | http, mcp | \`POST /api/capabilities/agent/brief\` |

## Remote MCP

\`POST /mcp\` serves the mcp-exposed capabilities as MCP tools over stateless
Streamable HTTP. \`tools/list\` is projected from the same graph, so the schemas
are the capability's own. Dots become underscores: \`projects.search\` →
\`projects_search\`.

\`\`\`bash
curl -sX POST /mcp -H 'content-type: application/json' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
\`\`\`

\`projects.archive\` is **not** in that list. It is destructive, so the
projection filters it out regardless of what it declares — the prepare/commit
flow stays on the HTTP endpoint where a human can be in the loop. The endpoint
also rejects any request carrying a cookie or an \`Origin\`: a browser session
can never authenticate remote MCP. \`Authorization\` is forwarded, and Web Bot
Auth signatures verify on \`POST /mcp\` exactly as they do on the HTTP
projection, so \`agent_brief\` answers a signed MCP client and denies an
unsigned one.

## Envelope

Every call answers the same shape:

\`\`\`jsonc
{ "ok": true, "data": { } }
{ "ok": false, "error": { "code": "invalid_input", "message": "…", "issues": [ ] } }
\`\`\`

Error codes you should handle: \`invalid_input\` (400, path-scoped issues),
\`agent_required\` (401), \`confirmation_required\` (409, carries a token),
\`confirmation_pending\` (409, a human has not decided yet),
\`confirmation_unavailable\` (403, nothing to bind a proposal to),
\`rate_limited\` (429).

## Identity

Sign requests per
[draft-meunier-web-bot-auth-architecture-02](https://www.ietf.org/archive/id/draft-meunier-web-bot-auth-architecture-02.html):
Ed25519 over \`("@authority" "signature-agent")\`, tag \`web-bot-auth\`. App policy
is \`observe\` — unsigned callers are served — except \`agent.brief\`, which
requires verification.

## Archiving is two-phase

1. \`POST /api/capabilities/projects/archive\` with \`{ "projectId": "corvus" }\` and
   no confirmation header → \`409 confirmation_required\` carrying
   \`error.confirmationToken\` and \`error.approvalId\`.
2. Repeat the call with **byte-identical input** plus \`x-pracht-confirm: <token>\`
   → \`409 confirmation_pending\` while a reviewer decides.
3. A person approves at \`/app/approvals\`.
4. Repeat step 2 → the capability runs, exactly once. The proposal is consumed;
   the same token cannot run it again.

Do not re-prepare while waiting. Re-preparing addresses the same proposal and
will not extend its life or reset the decision.

## Demo tasks worth trying

1. Find every project that is not live, and deploy the paused one.
2. Create a project called "Vega", then deploy it twice with the same
   idempotencyKey and show that the second call was deduped.
3. Archive Corvus end to end, including waiting for the human decision.
4. Fetch /llms.txt and report which capabilities are exposed over HTTP.
5. Explain why \`projects.archive\` appears in neither the WebMCP nor the MCP
   tool list.
6. Connect over \`POST /mcp\`, call \`projects_search\`, then explain what
   \`tools/list\` does *not* contain and why.
`;

export function head() {
  return {
    title: "Agent briefing — Launchpad",
    meta: [
      {
        name: "description",
        content:
          "What Launchpad exposes to autonomous callers: six capabilities, verified identity, and a two-phase archive flow gated on human approval.",
      },
    ],
  };
}

export function Component() {
  return (
    <article class="agent-page">
      <section class="agent-hero">
        <div class="hero-badge">
          <span class="hero-badge-dot" />
          Agent-native by design
        </div>
        <h1>
          The finished application is
          <br />
          <span class="gradient-text">the tool surface.</span>
        </h1>
        <p>
          Not "an agent can help you build this app" — that is a dev-time story every framework has
          now. This is the deployed product being usable by an agent, with the same rules, the same
          endpoints, and a trust layer that does not depend on the caller being honest.
        </p>
        <div class="agent-actions">
          <a href="/playground" class="btn btn-accent">
            Try the capabilities
          </a>
          <a href="/llms.txt" class="btn">
            Read /llms.txt
          </a>
        </div>
      </section>

      <section class="agent-terminal" aria-label="Agent session transcript">
        <div class="code-header">
          <div class="code-dots">
            <span />
            <span />
            <span />
          </div>
          <span class="code-title">agent session</span>
        </div>
        <pre>
          <code>
            <span class="cmt"># This page, as source content, from the same URL</span>
            {"\n"}
            <span class="kw">curl</span>
            {" -H "}
            <span class="str">"Accept: text/markdown"</span>
            {" https://launchpad.example/agents\n\n"}
            <span class="cmt"># A read capability — no ceremony</span>
            {"\n"}
            <span class="kw">curl</span>
            {" -X POST .../api/capabilities/projects/search -d "}
            <span class="str">{'\'{"query":"api"}\''}</span>
            {"\n\n"}
            <span class="cmt"># A destructive one — token first, then a human</span>
            {"\n"}
            <span class="kw">curl</span>
            {" -X POST .../api/capabilities/projects/archive -d "}
            <span class="str">{'\'{"projectId":"corvus"}\''}</span>
            {"\n"}
            <span class="cmt">
              {"# → 409 confirmation_required { confirmationToken, approvalId }"}
            </span>
            {"\n"}
            <span class="kw">curl</span>
            {" -X POST ... -H "}
            <span class="str">"x-pracht-confirm: $TOKEN"</span>
            {" -d "}
            <span class="str">{'\'{"projectId":"corvus"}\''}</span>
            {"\n"}
            <span class="cmt">{"# → 409 confirmation_pending — a person decides, not you"}</span>
          </code>
        </pre>
      </section>

      <section class="tool-table-wrap">
        <h2>What is exposed</h2>
        <table class="tool-table">
          <thead>
            <tr>
              <th>Capability</th>
              <th>Effect</th>
              <th>Exposure</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {TOOLS.map((tool) => (
              <tr key={tool.name}>
                <td>
                  <code>{tool.name}</code>
                </td>
                <td>
                  <span class={`effect-tag ${tool.effect}`}>{tool.effect}</span>
                </td>
                <td class="dim">{tool.exposure}</td>
                <td>{tool.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p class="footnote">
          <code>mcp</code> tools are served at <code>POST /mcp</code> — stateless Streamable HTTP,
          with <code>tools/list</code> projected from this same graph and dots replaced by
          underscores (<code>projects_search</code>). <code>projects.archive</code> is absent from
          that list by construction: the projection filters <code>destructive</code> capabilities
          out however they are declared. Drop <code>agents.mcp</code> from the manifest and the
          exposures stay in the graph but the dev banner prints <code>mcp(unserved)</code>, so a
          declared-but-dead transport is never mistaken for a live one.
        </p>
      </section>

      <section class="agent-terminal" aria-label="Remote MCP transcript">
        <div class="code-header">
          <div class="code-dots">
            <span />
            <span />
            <span />
          </div>
          <span class="code-title">remote mcp</span>
        </div>
        <pre>
          <code>
            <span class="cmt"># One endpoint, no session handshake</span>
            {"\n"}
            <span class="kw">curl</span>
            {" -sX POST https://launchpad.example/mcp -d "}
            <span class="str">{'\'{"jsonrpc":"2.0","id":1,"method":"tools/list"}\''}</span>
            {"\n"}
            <span class="cmt">
              {"# → projects_search, projects_create, projects_deploy, agent_whoami, agent_brief"}
            </span>
            {"\n"}
            <span class="cmt">{"#   (no projects_archive — destructive is filtered out)"}</span>
            {"\n\n"}
            <span class="cmt"># A cookie, or an Origin header, is a 403 — not a login</span>
            {"\n"}
            <span class="kw">curl</span>
            {" -sX POST .../mcp -H "}
            <span class="str">"cookie: session=demo"</span>
            {" …  "}
            <span class="cmt">{"# → 403"}</span>
          </code>
        </pre>
      </section>

      <section class="agent-grid">
        {STRENGTHS.map((strength) => (
          <div key={strength.title} class="agent-card">
            <h2>{strength.title}</h2>
            <p>{strength.detail}</p>
          </div>
        ))}
      </section>

      <section class="agent-briefing">
        <div>
          <p class="eyebrow">Run it yourself</p>
          <h2>A signed agent, in one command</h2>
          <p>
            <code>node scripts/agent.mjs</code> derives an Ed25519 key whose public half is pinned
            in this app's manifest, signs every request per RFC 9421, and walks the whole flow:
            identity, the verified-only brief, search, create, an idempotent double deploy, and an
            archive that stops dead waiting for a human.
          </p>
        </div>
        <ul>
          <li>
            <code>node scripts/agent.mjs</code> — the full transcript
          </li>
          <li>
            <code>node scripts/agent.mjs --unsigned</code> — watch <code>agent.brief</code> 401
          </li>
          <li>
            <code>pracht eval --start "pracht preview"</code> — the same flow as a CI check
          </li>
          <li>
            <code>pracht inspect capabilities --json</code> — the graph, with schemas
          </li>
        </ul>
      </section>
    </article>
  );
}
