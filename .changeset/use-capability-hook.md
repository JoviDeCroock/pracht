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
capability demands an explicit prepare marker or confirmation token and a
private one still does not compile.

It dispatches when called, never during render. Data a page needs on load still
belongs in a `loader` with `invokeCapability()`, which server-renders — fetching
during render would add a client-side waterfall and produce nothing during SSR.

Concurrent calls are last-one-wins, so an earlier response arriving after a later
one cannot render a stale result; `data` stays visible while a follow-up call is
pending or fails; nothing writes after unmount; `pending` never latches, including
when the dispatcher throws; and switching the capability name drops the previous
one's state — even after switching away and back — rather than carrying it under
the new one's output type. `call` and `reset` are scoped to the capability name
they were created for, so a handler a component still holds from before a name
change (a debounce wrapper, an interval, a listener bound in a mount effect)
cannot abandon the current capability's call.

A dispatcher rejection or malformed fulfilled value always clears `pending`
before surfacing the programming error. The generated browser dispatcher turns
malformed JSON envelopes into `invalid_response`; the factory keeps the same
no-latched-spinner guarantee for custom dispatchers.

`@pracht/core` also exports `createUseCapability`, the factory the generated
`virtual:pracht/capabilities` module binds to its own `callCapability`.
Applications import `useCapability` from that module; the factory is exported
only so one dispatch path can serve every projection.
