---
"@pracht/vite-plugin": patch
---

Resolve client module keys exactly against the app manifest directory instead of runtime suffix matching. The virtual client entry previously built a suffix index over every glob key at startup and matched manifest refs by path suffix — ambiguous refs (e.g. two routes both named `index.tsx`) silently resolved to whichever key iterated first. Refs now canonicalize against the manifest file's directory (known at build time) for an exact lookup. In dev, refs that only resolve by suffix still work but log a console error explaining how to fix them; production builds resolve strictly and drop the fallback entirely.
