# Agent Skill Publishing

Pracht can publish a directory of [Agent Skills](https://agentskills.io) as static,
CDN-ready assets. Configure the manifest rather than adding request middleware or a
custom Vite plugin:

```ts
import { defineApp } from "@pracht/core";

export const app = defineApp({
  agents: {
    skills: {
      directory: "./skills",
      manifest: {
        name: "my-app",
        homepage: "https://example.com",
      },
      advertise: true,
    },
  },
  routes: [],
});
```

`directory` is resolved from the Vite project root. It contains one directory per
skill, and each directory must contain a `SKILL.md` whose frontmatter `name` matches
the directory name:

```text
skills/
  deploy-app/
    SKILL.md
  review-code/
    SKILL.md
```

## Published assets

`pracht build` writes:

- `dist/client/.well-known/agent-skills/index.json`
- `dist/client/skills/<name>/SKILL.md`

The discovery index follows the Agent Skills Discovery draft v0.2 format. Each entry
uses `type: "skill-md"` and carries a `digest` formatted as
`sha256:<lowercase-hex>`. URLs are root-relative, so the same build can be promoted
between origins without regeneration. `name` and optional `homepage` from `manifest`
are included as publisher metadata; clients following the discovery draft ignore
unknown top-level fields.

All built-in adapters serve the Markdown as `text/markdown; charset=utf-8`, the index
as `application/json; charset=utf-8`, and both with
`Access-Control-Allow-Origin: *`. `GET` and `HEAD` work in development and production.
Cloudflare and Vercel use their static/CDN asset paths; Node serves the files from
`dist/client`.

With `advertise: true`, Pracht appends this RFC 8288 header without replacing any
application-provided `Link` values:

```http
Link: </.well-known/agent-skills/index.json>; rel="agent-skills"
```

Publishing reserves the generated URLs. If a public file, prerendered route, or
companion-generated artifact already occupies one of them, the generated Agent Skills
asset wins and the build reports the replacement.

## Validation

An enabled publication fails the build when the directory cannot be read, contains no
skills, or a skill has missing/invalid `name` or `description` frontmatter. Names must
match their parent directory and follow the Agent Skills naming rules: 1-64 lowercase
letters, numbers, and single hyphens. Frontmatter is parsed as YAML, including quoted
values and literal or folded block scalars with chomping indicators.
