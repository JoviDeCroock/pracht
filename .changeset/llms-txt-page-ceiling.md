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
`0` lists everything). The instances kept are the first ones `getStaticPaths()`
returns — the author's order, newest-first for most blogs — and they are still
printed in path order.

Truncation is never silent. A line in the free-form block above the `## Pages`
heading names the route and the ratio it lists:

```
_Pages lists 50 of 5000 prerendered URLs under `/blog/:slug`; 4950 are omitted. Raise `llmsTxt.maxPagesPerRoute` to include them._
```

It sits above the heading rather than inside the section because llms.txt only
allows free-form prose before the first `##`; a section is a file list, and the
reference parser throws on any line inside one that is not a link.

This changes existing output: an app whose dynamic route prerenders more than
50 instances will see its llms.txt shrink to 50 of them plus the note. Set
`llmsTxt: { maxPagesPerRoute: 0 }` to keep listing every instance.

The same build printed one line per prerendered page. `pracht build` now names
the first 20 and closes with `… and N more`; the total was already stated on
the line above.
