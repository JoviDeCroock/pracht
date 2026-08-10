---
"@pracht/core": patch
---

Deliver revalidated route data to the `data` prop, not just `useRouteData()`.

`componentProps` was built once when a route state was resolved, so a component
written as `Component({ data }: RouteComponentProps<typeof loader>)` — the shape
`create-pracht` scaffolds and `pracht generate route` emits — kept rendering the
data it was first given. Revalidation commits into the runtime provider, which
only context consumers observed, so `useRevalidate()`, `<Form capability>`, and
effect-driven revalidation after a successful non-`read` capability call all
silently left the page stale for prop-reading components. The client router now
renders route components through a wrapper that reads the provider, so the prop
and the hook always agree.

The provider's "reset from props" effect could also discard a revalidation
outright: effects are deferred to a frame, and a revalidation that settled
before the mount effect ran was overwritten by the initial props. Committed data
is now stored with the props that produced it and staleness is derived during
render, so the reset is a no-op when a newer commit exists — while a commit made
before a navigation is still discarded rather than published as the next route's
data.
