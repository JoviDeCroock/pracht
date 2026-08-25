---
"@pracht/vite-plugin": patch
---

Keep `@pracht/*` packages inlined in the dev SSR environment, not just in SSR
builds. `pracht dev` renders through `ssrLoadModule("@pracht/core/server")`,
which Vite always inlines, while an app's own `import { useLocation } from
"@pracht/core"` is a bare node_modules id Vite externalizes to a native Node
import. Apps that install Pracht from the registry therefore rendered with two
copies of the runtime in the same request: the document was rendered with the
inlined copy's `RouteDataContext.Provider`, and every component read the
externalized copy's context. `useLocation()` fell back to `/`, `useParams()` to
`{}`, and `useRouteData()` to `undefined` during development SSR, and the page
hydrated into a mismatch — while production builds, which already inlined these
packages, were correct. Workspace-linked installs were inlined either way and
never saw it.
