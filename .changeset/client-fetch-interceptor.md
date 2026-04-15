---
"@pracht/core": minor
---

Add `configureClient({ fetch })` so apps can install a custom fetch implementation for every framework-initiated client request — route-state fetches during navigation, revalidation, and prefetch, as well as `<Form>` submissions. Enables forwarding auth headers (e.g. `Authorization: Bearer …`) to loaders on client-side navigations without losing them after initial SSR.
