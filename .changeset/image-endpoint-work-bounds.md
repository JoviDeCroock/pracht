---
"@pracht/image": minor
---

The image endpoint now drops the query string from local image files (`/hero.png?v=2` is fetched as `/hero.png`), keeps recent results in memory for no longer than your `cacheControl` allows (`cache`), and optimizes at most four images at once (`maxConcurrency`), answering `503` when too many are waiting. If a local image source relies on a query parameter, such as a cache-busting version or a signature, list it in `createImageHandler({ sourceQueryParams: ["v"] })`.
