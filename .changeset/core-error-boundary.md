---
"@pracht/core": minor
---

Add an `ErrorBoundary` component.

Pracht already lets a route or shell export `ErrorBoundary` to handle its own
failures, and exports `Suspense`/`lazy`, but had nothing for the smaller case:
containing a failure inside part of an otherwise working page. Apps reached for
`preact-iso`'s boundary, which pulls a second router and a second suspense
implementation into the client bundle.

```jsx
import { ErrorBoundary } from "@pracht/core";

<ErrorBoundary fallback={(error, retry) => <Failed error={error} onRetry={retry} />}>
  <Editor />
</ErrorBoundary>;
```

`fallback` accepts a node or a function of `(error, retry)`, and `onError` is
called with every caught error. Boundaries work during server rendering as well
as in the browser. Promises thrown for suspension are declined, so an enclosing
`<Suspense>` still sees them.
