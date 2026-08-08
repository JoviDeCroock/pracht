# Preact v11 Streaming SSR Experiment

Status: successful upstream experiment, not a Pracht streaming API.

This experiment pins the workspace to `preact@11.0.0-beta.2` and
`preact-render-to-string@6.7.0`. It checks whether Preact v11's Hydration 2.0
markers and streamed-hydration coordination are sound enough for Pracht to
build on. The versions are workspace overrides so every existing Pracht test
also runs against the same Preact pair without changing the published package
peer ranges.

The browser fixture lives in `e2e/fixtures/preact-v11-streaming`. It is a small
Vite-backed Node server rather than a Pracht rendering path. That separation is
intentional: the experiment tests upstream semantics before Pracht commits to a
public streaming contract.

## Hypotheses and Results

| Hypothesis | Browser assertion | Result |
| --- | --- | --- |
| A streamed response exposes useful HTML before an async boundary resolves | The Suspense fallback is visible while the resolved button is still absent | Supported |
| Hydration survives when the server stream wins the race | The streamed button keeps its DOM identity through client resumption, remains singular, and becomes interactive | Supported |
| Hydration survives when the client promise wins the race | Preact keeps the fallback parked until the server boundary arrives, then hydrates one interactive result | Supported |
| Hydration 2.0 handles a suspended component that returns `null` | The following sibling remains singular and in the correct position | Supported |
| Hydration 2.0 handles a suspended component that returns multiple DOM nodes | Both nodes and the following sibling remain singular; the server button is reused and becomes interactive | Supported |
| The existing Pracht hydration logic can execute on the pinned beta | The suspended-hydration and mismatch unit suites pass | Supported for the tested cases |
| `<head>` and `<body>` can hold independent streaming boundaries | Each region resolves and patches on its own schedule, in either order | Supported, but not recommended — see the guidance below |
| A shell-rendered `<head>` keeps streaming's body benefits without its head costs | The head is complete in the first flush and survives with scripting disabled, while the body still streams | Supported |

All browser cases also fail on console warnings, console errors, and uncaught
page errors, so a visually correct result cannot hide a hydration diagnostic.

## Streaming Both Head and Body

The `/head-body` fixture route puts a Suspense boundary inside `<head>`
(resolving to `<title>`, `<meta name="description">`, and a canonical `<link>`)
alongside one in `<body>`, and hydrates `document.documentElement` so Preact —
not a hand-written shell — owns the whole document.

It works. The two regions are independent: the body boundary can resolve first
and land while the head still shows its fallback title, or the head can resolve
first while the body fallback is still on screen. Both orders are asserted.

Mechanically, `preact-render-to-string` flushes the shell up to the last
`</body>`, then parks each resolved boundary in a trailing `<div hidden>` as a
`<preact-island>` custom element. Its `connectedCallback` walks *the entire
document* for the `<!--$s:ID-->` marker pair, so a marker pair in `<head>` is
found and the resolved nodes are moved into `<head>`. Three things worth
recording:

- Full-document hydration reuses the streamed head nodes rather than replacing
  them — the test tags the streamed `<meta>` with a JS property and the
  property survives hydration. A streamed stylesheet or preload would therefore
  not refetch.
- Preact removes the leftover `<div hidden>` stream wrapper as an unmatched
  trailing child of `<body>`, so the scaffolding cleans itself up.
- There is no race between the island's `requestAnimationFrame` patch and
  hydration. The client entry is a module script, so it is deferred until
  parsing — that is, the stream — completes. Tests with the client boundary
  resolving immediately (`clientDelay=0`) and with both server boundaries
  resolving on the same tick are clean.

### The scripting caveat

Patching a resolved boundary into place is the inline init script's job, so
**with scripting disabled nothing in a streamed `<head>` is applied**. The
resolved head markup is not merely missing — it is stranded in the body, and
the document ends up with two `<title>` elements: the fallback in `<head>` and
the real one inside the hidden wrapper. `document.title` reports the fallback
because it comes first in tree order.

That makes a suspended `<head>` boundary meaningfully riskier than a suspended
`<body>` boundary. Body content degrades to a visible fallback, which is
recoverable. Head content is exactly what non-rendering consumers read, so a
route whose title or description depends on an async loader would serve a
placeholder title, no description, and no canonical URL to any client that does
not run the patcher.

## Guidance: Render the Head in the Shell, Stream the Body

**Do not suspend inside `<head>`. Resolve head content synchronously in the
shell so it lands complete in the first flush, and let only `<body>` stream.**

The `/shell-head` fixture route is the recommended shape, and it is asserted
alongside the `/head-body` one so the contrast stays honest. Its `<head>` has no
Suspense boundary; the body keeps one. Preact still owns the whole document via
`document.documentElement` hydration, so head content remains hydrated and
client-updatable — it just never depends on the patcher script to be correct.

What that buys, versus streaming the head:

| | Streamed `<head>` (`/head-body`) | Shell `<head>` (`/shell-head`) |
| --- | --- | --- |
| Head in the first flush | Fallback title only | Complete and final |
| With scripting disabled | Fallback title, no description, no canonical, and a second `<title>` stranded in `<body>` | Fully correct |
| Body streaming | Yes | Yes, unchanged |
| Cost | None at render time | The head's data must resolve before the first byte |

The cost is real but small and predictable: whatever feeds `head()` has to be
awaited before the stream opens, so it gates TTFB. Everything else on the page
can still suspend. In exchange the head is correct for every client, and
`<link rel="preload">` / `<link rel="stylesheet">` land early enough for the
browser's preload scanner to act on them — which a streamed head cannot do
anyway, since it arrives after the body has already been parsed. Streaming the
head trades away correctness for no latency win.

Concretely, for a future Pracht streaming mode:

- `head()` output belongs in the shell. Await the loader data it depends on
  before opening the stream.
- Route components below the head may suspend freely; that is where streaming
  pays off.
- If a route genuinely needs late head mutation (an analytics tag, a
  client-only theme color), do it from an effect after hydration rather than
  from a `<head>` Suspense boundary — the failure mode is then "missing
  enhancement" rather than "wrong metadata".
- If streaming the head is ever exposed at all, it should be an explicit
  per-route opt-in that documents the crawler cost, never the default.

Run the focused experiment with:

```sh
pnpm exec playwright test --project preact-v11-streaming
```

## What This Does Not Prove

Pracht still calls `renderToStringAsync()` and buffers a complete document.
This experiment does not add streaming to `handlePrachtRequest()`, any adapter,
or any route configuration.

Before exposing streaming as framework behavior, a production design still
needs to cover:

- hydration-state, preload, and client-entry ordering;
- how far up the tree the shell boundary sits, now that the head must resolve
  before the first byte — which loader data gates TTFB is a routing decision
  this experiment does not make;
- redirects and errors before and after the first byte;
- request cancellation, stream aborts, backpressure, and adapter lifetimes;
- CSP treatment of the inline stream-patcher script;
- nested and concurrent Suspense boundaries;
- islands, SSG/ISG caching, and client navigation interactions;
- Node, Cloudflare, and Vercel deployment behavior.

The experiment uses `Suspense` from `preact/compat`. Pracht's current
`preact-suspense@0.3.0` dependency still declares a Preact 10 peer range. Its
existing tests pass under the forced v11 resolution, but that is not an
upstream compatibility guarantee and must be resolved before Pracht advertises
Preact v11 support.

The streamed marker protocol may also move: the template-based follow-up in
`preact` and `preact-render-to-string` was still open when this experiment was
recorded. Keep the exact beta and renderer versions pinned until that protocol
settles.

## Conclusion

The Hydration 2.0 hypothesis is supported for the high-risk DOM-pointer cases
that motivated it: empty results, multi-node results, and both sides of the
stream/client race. Streaming both `<head>` and `<body>` in one document also
works mechanically, including out-of-order resolution and full-document
hydration.

But "works" and "should" diverge here. Streaming the head costs correctness for
every client that does not run the patcher script and wins no latency in
return, so the recommended shape is a shell-rendered `<head>` with a streamed
`<body>` — proven by the `/shell-head` route and its scripting-disabled case.

This is strong enough to proceed to a Pracht-specific streaming design, but not
enough to silently switch today's SSR responses from buffered strings to
streams.

Upstream context:

- [Preact v11 beta.2 release](https://github.com/preactjs/preact/releases/tag/11.0.0-beta.2)
- [Hydration 2.0 RFC](https://github.com/preactjs/preact/issues/4442)
- [Streaming hydration coordination RFC](https://github.com/preactjs/preact/issues/5034)
- [Open template-based streaming follow-up](https://github.com/preactjs/preact/pull/5153)
