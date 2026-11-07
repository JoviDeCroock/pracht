---
title: Client hooks
lead: Read route data, search params, and navigation state in components, revalidate loaders, and block navigation with the hooks from `@pracht/core`.
---

Import these hooks from `@pracht/core` and call them in route and shell components.

## useRouteData()

Read the current route's loader data. It updates on navigation and
revalidation. After `pracht typegen`, pass the route id to infer the type from
that route's loader:

```ts
export function Component() {
  const data = useRouteData("dashboard");
  return <span>{data.user.name}</span>;
}
```

The id only sets the type; an id other than the active route's throws. Without
typegen, pass the loader type as a generic:

```ts
export function Component() {
  const data = useRouteData<typeof loader>();
  return <span>{data.user.name}</span>;
}
```

## useShellData()

Read the [shell loader's](/docs/shells#shell-data) data from the shell or any route inside it. It is `undefined` when the shell has no loader:

```ts
const shell = useShellData("app"); // or useShellData<typeof loader>()
```

## useSearchParams()

Read the current query string as a reactive, read-only `URLSearchParams`:

```tsx
import { useSearchParams } from "@pracht/core";

export function Component() {
  const searchParams = useSearchParams();
  return <p>Language: {searchParams.get("lang") ?? "en"}</p>;
}
```

On an SSG page it returns the build-time query during hydration, then the
browser's; use `useIsHydrated()` or stable fallback UI to avoid a visible
change. Use SSR when the query must affect loader data or the initial HTML, and
a [`search` schema](/docs/routing#search-params) to validate and type it.

## useSetSearchParams()

Change the current page's query. Loaders re-run and `useSearchParams()`
updates. It accepts an object, a function, a string, or `URLSearchParams`:

```tsx
const setSearchParams = useSetSearchParams();

setSearchParams({ sort: "price", tag: ["a", "b"] }, { preserveScroll: true });
setSearchParams((query) => (query.delete("page"), query), { replace: true });
```

## useRevalidate()

Re-run the current route's loader and its shell's:

```ts
export function Component() {
  const revalidate = useRevalidate();
  return <button onClick={() => revalidate()}>Refresh</button>;
}
```

Revalidation bypasses `loaderCache`. When revalidations overlap, the page keeps
the data of the one started last.

## useNavigation()

Read the pending state of the current navigation or `<Form>` submission for
progress bars, pending buttons, and optimistic UI:

```ts
import { useNavigation } from "@pracht/core";

function NavigationProgress() {
  const navigation = useNavigation();
  if (navigation.state === "idle") return null;
  return <div class="nav-progress" role="progressbar" aria-label="Loading page" />;
}
```

- `state` — `"idle"`, `"loading"` (navigation in flight), or `"submitting"` (`<Form>` awaiting its response)
- `location` — the target `{ pathname, search, hash, href }` while not idle
- `formData` — the submitted `FormData` while a submission is pending

## useBlocker()

Stop a navigation before it commits, for example to guard unsaved changes:

```tsx
import { useBlocker } from "@pracht/core";

export function Component() {
  const [dirty, setDirty] = useState(false);
  const blocker = useBlocker(dirty);

  return (
    <>
      <textarea onInput={() => setDirty(true)} />
      {blocker.state === "blocked" && (
        <dialog open>
          <p>Discard your unsaved changes?</p>
          <button onClick={blocker.proceed}>Discard</button>
          <button onClick={blocker.reset}>Keep editing</button>
        </dialog>
      )}
    </>
  );
}
```

- `state` — `"unblocked"`, `"blocked"` (a navigation is waiting on you), or `"proceeding"`
- `location` — where the blocked navigation was going, while blocked
- `proceed()` — let it continue
- `reset()` — abandon it and stay put

Pass a predicate instead of a boolean to decide per navigation:

```ts
const blocker = useBlocker(
  ({ nextLocation }) => dirty && nextLocation?.pathname !== "/drafts",
);
```

The predicate receives `{ currentLocation, nextLocation, historyAction }`;
`historyAction` is `"push"`, `"replace"`, `"pop"`, or `"unload"`.

It guards `<Link>` clicks, `useNavigate()` calls, and back/forward. Reloads,
closed tabs, and cross-origin links get the browser's `beforeunload` dialog,
with `nextLocation: null` and `historyAction: "unload"`; opt out with
`useBlocker(dirty, { beforeUnload: false })`.

It does not guard `<Form>` submissions, or back/forward onto entries your code
pushed with `history.pushState()`. Render one blocker at a time; a second wins
and warns in development.

An app that never blocks navigation can compile the guards out:

```ts [vite.config.ts]
pracht({ client: { navigationGuards: false } });
```

`useBlocker()` then stays importable but never blocks, and warns in development.

## \<Form\> component

`<Form>` submits same-origin forms over `fetch` without a page reload and drives
`useNavigation()`'s `"submitting"` state. Cross-origin actions, and any form
before JavaScript loads, submit natively. Set `action` to an API route path, or
`capability` to post to a [capability](/docs/capabilities) endpoint. See
[Mutations](/docs/data-loading#mutations) for a full example.
