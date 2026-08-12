---
"@pracht/core": minor
---

Add a first-party font helper for self-hosted fonts. `defineFont({ family, src, weight?, style?, display?, preload?, unicodeRange?, fallbacks?, metricsFallback?, sizeAdjust?, ascentOverride?, descentOverride?, lineGapOverride? })` returns a typed font object you register through the new `fonts` array on `HeadMetadata` (`head() { return { title, fonts: [inter] } }`) and consume in components via `.className`, `.style`, or `.fontFamily`.

The head renderer expands each font into `<link rel="preload" as="font" type="font/woff2" crossorigin="anonymous">` plus one inline `<style>` with the `@font-face` rules. Duplicate registrations (shell + route, or several routes) collapse to one preload per file and one `@font-face` per distinct face — unicode-range subsets of the same family each keep their own face. Optional metric overrides (`sizeAdjust`, `ascentOverride`, `descentOverride`, `lineGapOverride`) emit an adjusted `local()` fallback face to prevent font-swap layout shift; its family name carries a metrics hash so per-weight metrics never clobber each other. All interpolated CSS values are escaped or validated; nothing is fetched at build time.
