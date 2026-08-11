---
"@pracht/core": minor
"@pracht/vite-plugin": minor
"@pracht/cli": patch
"@pracht/adapter-node": patch
"@pracht/adapter-cloudflare": patch
"@pracht/adapter-vercel": patch
---

Publish Agent Skills as built-in static assets with
`defineApp({ agents: { skills } })`. Pracht validates each `<name>/SKILL.md`, emits
`/.well-known/agent-skills/index.json` and `/skills/<name>/SKILL.md`, and records
v0.2 `sha256:` integrity digests in deterministic discovery output.

Development and production now serve the generated index and Markdown through
the same asset paths on Node, Cloudflare, and Vercel, including `GET`/`HEAD`,
explicit JSON/Markdown MIME types, CORS, baseline security headers, and optional
RFC 8288 `Link: rel="agent-skills"` advertisement. The generated files land in
`dist/client` and Vercel's static output so deployment CDNs handle them without
not-found middleware or request-time filesystem scans.

Skill frontmatter is parsed as YAML, including block scalar modifiers. Reserved
Agent Skills paths win over public, prerendered, and companion-generated files,
and Vercel emits CORS/discovery metadata through Build Output API routes with
static MIME overrides.
