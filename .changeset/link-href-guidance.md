---
"@pracht/core": minor
"create-pracht": patch
---

Make the `<Link href>` compile error name the fix.

`href` is the muscle-memory prop from every other router, so it is the first
wall a new pracht app hits. `LinkProps` did not declare it, which left TypeScript
to guess: `Property 'href' does not exist … Did you mean 'ref'?` — a suggestion
that sends the reader hunting for a typo rather than at the API. The prop is now
declared with a single-value string type carrying the guidance, so the compiler
prints it:

```
Type '"/blog/hello"' is not assignable to type '"`href` is not a <Link> prop:
<Link> builds its own href from `route` and `params`. Use <Link route="home">,
a plain <a href> for external and user-provided URLs, or omit href from the
props you spread here."'
```

**Source-breaking for one pattern.** JSX does not check spreads for excess
properties, so an object carrying an optional `href` could be spread into
`<Link>` and compiled — and `<Link>` silently dropped it, because it always
overwrites `href` with the one it builds from `route` and `params`. That now
fails to typecheck:

```tsx
type ButtonLinkProps = JSX.AnchorHTMLAttributes<HTMLAnchorElement> & { route: RouteId };
function ButtonLink({ route, ...rest }: ButtonLinkProps) {
  return <Link route={route} {...rest} />; // `rest` still carries `href`
}
```

Migration: drop `href` from the wrapper's own props —
`Omit<JSX.AnchorHTMLAttributes<HTMLAnchorElement>, "href">` — or stop forwarding
it. The link never navigated to that `href`, so nothing about the rendered
output changes.

**`<Link>` now accepts the anchor attributes.** `LinkProps` was based on
`JSX.HTMLAttributes<HTMLAnchorElement>`, but Preact keeps `target`, `rel`,
`download`, `ping`, `referrerpolicy`, and `hreflang` on
`JSX.AnchorHTMLAttributes` — so none of them typechecked, and
`<Link route="home" target="_blank">` needed a cast. It also meant the
`Omit<…, "href">` removed nothing, since `href` was never in the generic
interface either; that, not the `Omit`, is why the compiler answered
`<Link href>` with `Did you mean 'ref'?`. The base type is now
`Omit<JSX.AnchorHTMLAttributes<HTMLAnchorElement>, "href">`, which is purely
widening.

`create-pracht` also seeds a Conventions section in `AGENTS.md` naming the
route-id API, since that file is what a coding agent reads before writing its
first link. The ids it names come from the router that was actually scaffolded:
the manifest scaffold declares `home`, and the pages router derives ids from
filenames, so its home page is `index`.

The scaffolded `README.md` gained the same Navigating note, since `AGENTS.md`
is only seeded when agent tooling is enabled and this is the convention a new
app trips over before it writes anything else.
