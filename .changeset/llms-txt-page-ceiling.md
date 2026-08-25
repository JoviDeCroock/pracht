---
"@pracht/core": minor
"@pracht/vite-plugin": minor
"@pracht/cli": patch
---

Stop llms.txt and the build log from scaling with the number of prerendered
pages.

A dynamic SSG/ISG route expanded every `getStaticPaths()` instance into the
Pages section, so a 5,000-post blog produced a 5,000-line, 180 KB llms.txt —
larger than most agent context budgets, and a sitemap rather than the index
llms.txt is meant to be. Each dynamic route now contributes at most
`llmsTxt.maxPagesPerRoute` instances (50 by default, applied after `exclude`,
`0` lists everything), and the section says what it left out rather than
trailing off:

```
_4,950 more prerendered pages under `/blog/:slug` are not listed. Raise
`llmsTxt.maxPagesPerRoute` to include them._
```

The same build printed one line per prerendered page. `pracht build` now names
the first 20 and closes with `… and N more`; the total was already stated on
the line above.
