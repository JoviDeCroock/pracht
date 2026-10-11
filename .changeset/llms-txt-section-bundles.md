---
"@pracht/content": minor
---

`llmsTxtArtifacts()` can now link each entry to a URL you choose with `link(document)`, such as the page's `.md` source, and emit a full-text file per section with `sections[n].fullPath`, listed under the summary's `## Optional` heading. Sections marked `optional` now share that single trailing `## Optional` heading instead of each emitting their own.
