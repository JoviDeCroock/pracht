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

All browser cases also fail on console warnings, console errors, and uncaught
page errors, so a visually correct result cannot hide a hydration diagnostic.

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

- document head, hydration-state, preload, and client-entry ordering;
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
stream/client race. This is strong enough to proceed to a Pracht-specific
streaming design, but not enough to silently switch today's SSR responses from
buffered strings to streams.

Upstream context:

- [Preact v11 beta.2 release](https://github.com/preactjs/preact/releases/tag/11.0.0-beta.2)
- [Hydration 2.0 RFC](https://github.com/preactjs/preact/issues/4442)
- [Streaming hydration coordination RFC](https://github.com/preactjs/preact/issues/5034)
- [Open template-based streaming follow-up](https://github.com/preactjs/preact/pull/5153)
