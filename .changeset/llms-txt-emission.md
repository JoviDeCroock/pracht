---
"@pracht/core": minor
"@pracht/vite-plugin": minor
"@pracht/cli": minor
"create-pracht": patch
---

Opt-in llms.txt emission (https://llmstxt.org). Enable via the new `pracht({ llmsTxt })` plugin option: `pracht build` writes `dist/client/llms.txt` generated from the resolved app graph (H1 title + blockquote description with package.json fallbacks, a "## Pages" section listing routes as markdown links — dynamic SSG/ISG routes expanded through `getStaticPaths()`, other dynamic routes skipped — with `Accept: text/markdown` support annotated, and a "## API" section listing endpoints with their detected methods), and the dev server serves `/llms.txt` live from the current graph. Output ordering is deterministic. All three adapters serve the file as a regular static asset; disabled apps are byte-for-byte unchanged. `@pracht/core` gains a `buildLlmsTxt()` export on `@pracht/core/server`, and `create-pracht` templates enable the option by default. See `docs/LLMS_TXT.md`.
