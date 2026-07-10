---
title: Agent Skills
lead: pracht ships 28 Claude Code skills for scaffolding, auditing, testing, and deploying apps. They are published at stable URLs with a signed discovery manifest, seeded into new apps by <code>create-pracht</code>, and pair with the built-in MCP server.
breadcrumb: Agent Skills
prev:
  href: /docs/agent-workflow
  title: AI-Assisted Authoring & Review
next:
  href: /docs/capabilities
  title: Capabilities
---

## What Ships

Every skill is a single `SKILL.md` — frontmatter (`name`, `version`, `description`, `allowed-tools`) plus an action-oriented body — that Claude Code loads from `.claude/skills/<name>/SKILL.md` and invokes with `/<skill-name>`. The catalog covers four categories:

| Category                | Skills                                                                                                                                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework & migration   | `/pracht-scaffold`, `/pracht-debug`, `/pracht-deploy`, `/migrate-nextjs`, `/upgrade-pracht`                                                                                                     |
| Audit & review          | `/audit-loaders`, `/audit-shells`, `/audit-islands`, `/audit-auth`, `/audit-csrf`, `/audit-headers`, `/audit-secrets`, `/audit-redirects`, `/audit-deps`, `/audit-bundles`, `/audit-seo`, `/audit-a11y`, `/tune-render-mode`, `/pre-deploy` |
| Testing scaffolds       | `/scaffold-tests`, `/scaffold-e2e`, `/pracht-test-api`                                                                                                                                          |
| App primitives          | `/add-auth`, `/add-db`, `/add-i18n`, `/add-observability`, `/typed-routes`, `/configure-isg`                                                                                                    |

The source of truth lives in the repo's [skills/ directory](https://github.com/JoviDeCroock/pracht/tree/main/skills), with per-skill descriptions in [skills/README.md](https://github.com/JoviDeCroock/pracht/blob/main/skills/README.md). Instead of globbing `src/`, the skills read the resolved app graph via `pracht inspect routes|api|build --json`, so they account for groups, inheritance, and both routers.

---

## Discovery Endpoint

The skills are published following the [agent skills discovery RFC](https://github.com/cloudflare/agent-skills-discovery-rfc). A well-known manifest lists every skill with a canonical URL and a SHA-256 digest of its source:

```sh
curl https://pracht.resynapse.dev/.well-known/agent-skills/index.json
```

```json
{
  "$schema": "https://agentskills.io/schema/v0.2.0/index.json",
  "skills": [
    {
      "name": "audit-csrf",
      "type": "claude-skill",
      "description": "Verify CSRF posture on forms and mutation APIs...",
      "url": "https://pracht.resynapse.dev/skills/audit-csrf/SKILL.md",
      "sha256": "…"
    }
  ]
}
```

Agents landing on the home page can find the manifest without prior knowledge — it is advertised with an [RFC 8288](https://datatracker.ietf.org/doc/html/rfc8288) `Link` header:

```
Link: </.well-known/agent-skills/index.json>; rel="agent-skills"
```

Both are emitted by a small Vite plugin ([`vite-plugin-agent-skills.ts`](https://github.com/JoviDeCroock/pracht/blob/main/examples/docs/vite-plugin-agent-skills.ts)) that reads the repo skills at build time, computes the digests, and serves each `SKILL.md` as a public asset.

---

## Manual Install

Each skill is a plain Markdown file at a stable URL, so installing one into any app is a single `curl` into your `.claude/skills/` directory:

```sh
mkdir -p .claude/skills/audit-csrf
curl -o .claude/skills/audit-csrf/SKILL.md \
  https://pracht.resynapse.dev/skills/audit-csrf/SKILL.md
```

Restart Claude Code (or start a new session) and invoke it with `/audit-csrf`. Verify a download against the manifest's `sha256` if you want integrity checking:

```sh
shasum -a 256 .claude/skills/audit-csrf/SKILL.md
```

---

## Seeded by create-pracht

New apps do not need to install anything manually. `npm create pracht@latest` asks — with a yes default — whether to set up agent tooling:

```
Set up Claude Code skills + MCP? (Y/n):
```

Accepting seeds two things into the scaffold:

- `.claude/skills/<name>/SKILL.md` — the full skill catalog, ready for Claude Code to discover.
- `.mcp.json` — registers the `pracht mcp` server so MCP clients pick it up automatically.

Pass `--agent-tools` / `--no-agent-tools` to skip the prompt in scripted runs; `--yes` includes the tooling.

---

## Relationship to the MCP Server

The skills shell out to `pracht inspect ... --json`, `pracht doctor`, and `pracht verify`. The [built-in MCP server](https://github.com/JoviDeCroock/pracht/blob/main/docs/MCP.md) (`pracht mcp`) exposes the same capabilities as native tools — inspect, doctor, verify, and generate — for clients that prefer tool calls over shell access. The seeded `.mcp.json` wires it up:

```json
{
  "mcpServers": {
    "pracht": {
      "command": "npx",
      "args": ["pracht", "mcp"]
    }
  }
}
```

Skills and MCP tools share the same source of truth: the resolved app manifest. Use whichever fits your client — or both.
