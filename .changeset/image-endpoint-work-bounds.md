---
"@pracht/image": patch
---

The image endpoint now drops the query string from local image files (keep chosen parameters with `sourceQueryParams`), serves repeated requests from an in-memory cache (`cache`), and optimizes at most four images at once (`maxConcurrency`), answering `503` when too many are waiting.
