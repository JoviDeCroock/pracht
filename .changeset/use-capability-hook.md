---
"@pracht/vite-plugin": minor
"@pracht/core": minor
---

Add `useCapability()` for calls driven by user interaction.

`<Form capability>` already covers form submissions, but a button, a search box,
or a picker left components hand-rolling pending/error/result state around
`callCapability`. The hook is that state and nothing more:

```tsx
const search = useCapability("notes.search");
await search.call({ query });
// search.data / search.error / search.pending / search.reset()
```

Typed from the same registration as `callCapability`, so a `destructive`
capability still demands its confirmation token and a private one still does not
compile.

It dispatches when called, never during render. Data a page needs on load still
belongs in a `loader` with `invokeCapability()`, which server-renders — fetching
during render would add a client-side waterfall and produce nothing during SSR.

Concurrent calls are last-one-wins, so an earlier response arriving after a later
one cannot render a stale result; `data` stays visible while a follow-up call is
pending; nothing writes after unmount; `pending` never latches, including when
the dispatcher throws; and switching the capability name drops the previous one's
state rather than carrying it under the new one's output type.
