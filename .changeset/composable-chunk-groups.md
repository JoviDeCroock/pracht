---
"@pracht/vite-plugin": minor
---

Compose the framework vendor chunk with the app's chunking instead of replacing it.

Pracht now reads `build.rollupOptions.output` and contributes its Preact group
in the same form the app used — `codeSplitting.groups`, `advancedChunks.groups`,
or a wrapped `manualChunks` function. Previously it always wrote `manualChunks`,
which Rolldown ignores as soon as an app sets `codeSplitting`: configuring
chunking (to group feature modules, say) silently cost you the vendor
chunk, and an app-provided `manualChunks` was overwritten outright.

New `pracht({ vendorChunk: false })` opts out entirely, and `frameworkChunkGroups()`
is exported for apps that want to place the framework group themselves.
