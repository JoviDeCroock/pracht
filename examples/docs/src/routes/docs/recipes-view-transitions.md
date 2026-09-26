---
title: View Transitions
lead: Animate route changes with the browser View Transitions API — client-side navigations and full page loads to islands and static pages alike — while keeping pracht's data loading, scroll restoration, and fallback behavior intact.
breadcrumb: View Transitions
prev:
  href: /docs/recipes/forms
  title: Forms
next:
  href: /docs/recipes/testing
  title: Testing
---

## The Short Version

View transitions are opt-in. Pracht wraps the route commit in
`document.startViewTransition()` when the browser supports it, and falls back
to a normal client navigation everywhere else.

```tsx [src/routes/gallery.tsx]
import { Link } from "@pracht/core";

export function Component({ data }) {
  return (
    <div class="gallery-grid">
      {data.photos.map((photo) => (
        <Link
          key={photo.id}
          route="photo"
          params={{ id: photo.id }}
          prefetch="viewport"
          viewTransition
        >
          <img
            src={photo.thumbnail}
            alt={photo.title}
            style={{ viewTransitionName: `photo-${photo.id}` }}
          />
          <span>{photo.title}</span>
        </Link>
      ))}
    </div>
  );
}
```

Use regular View Transitions CSS to control the animation:

```css [src/styles/global.css]
@media (prefers-reduced-motion: no-preference) {
  ::view-transition-old(root) {
    animation: fade-out 160ms ease both;
  }

  ::view-transition-new(root) {
    animation: fade-in 220ms ease both;
  }
}

@keyframes fade-out {
  to {
    opacity: 0;
  }
}

@keyframes fade-in {
  from {
    opacity: 0;
  }
}
```

---

## Enable Per Navigation

Use `<Link viewTransition>` when a specific route change should animate:

```tsx
import { Link } from "@pracht/core";

<Link route="gallery" viewTransition>
  Gallery
</Link>;
```

The prop is rendered as a `data-pracht-view-transition` attribute on the
underlying anchor, so the client router can read it from delegated click
handlers.

For imperative navigation, pass the same option to `navigate()`:

```tsx
import { useNavigate } from "@pracht/core";

export function OpenGalleryButton() {
  const navigate = useNavigate();

  return (
    <button
      type="button"
      onClick={() => void navigate("/gallery", { viewTransition: true })}
    >
      Open gallery
    </button>
  );
}
```

---

## Enable App-Wide

Set `viewTransitions: true` in the app manifest when most client-side
navigations should animate:

```ts [src/routes.ts]
import { defineApp, route } from "@pracht/core";

export const app = defineApp({
  viewTransitions: true,
  routes: [
    route("/", "./routes/home.tsx", { id: "home", render: "ssg" }),
    route("/gallery", "./routes/gallery.tsx", { id: "gallery", render: "ssg" }),
    route("/gallery/:id", "./routes/photo.tsx", { id: "photo", render: "ssr" }),
  ],
});
```

Programmatic navigations can still opt out when a route change should commit
immediately:

```ts
import { useNavigate } from "@pracht/core";

const navigate = useNavigate();

await navigate("/settings", { viewTransition: false });
```

The app-wide switch also covers full page loads — see the next section.

---

## Islands And Static Pages

Routes with `hydration: "islands"` or `hydration: "none"` do not load the
client router, so every navigation to, from, or between them is a full page
load. `<Link viewTransition>` and `navigate()` options cannot animate those.
The browser can: with `viewTransitions: true`, every page document pracht
renders carries the cross-document opt-in in its `<head>`:

```html
<style data-pracht-view-transitions>@view-transition{navigation:auto}</style>
```

A same-origin navigation between two documents that both carry this rule —
a link click, a form submission, back/forward, but not a reload — animates as
a cross-document view transition. It is plain CSS: a `hydration: "none"` page
still ships zero JavaScript.

Full-hydration pages carry the rule too, because the old *and* the new
document must opt in. Leaving a full-hydration page for an islands page (the
client router hands that navigation to the browser) therefore animates as
well. Navigations the client router handles itself are same-document, which
the rule does not affect: they animate once, through
`document.startViewTransition()`, exactly as before.

The same CSS drives both kinds of transition. `::view-transition-old(root)` /
`::view-transition-new(root)` rules and `view-transition-name` on matching
elements apply across documents unchanged, so the
[named photo transition](#named-element-transitions) also works when the
gallery and photo pages are islands routes. Put the names in CSS or
server-rendered `style` attributes: they must be present when the old page is
captured and when the new page first renders.

There is no per-route manifest switch: a cross-document transition needs the
rule on both pages, so it is an app-wide setting. To keep a single page out of
cross-document transitions (to and from it), override the rule in that page's
stylesheet, which loads after pracht's:

```css [src/routes/checkout.css]
@view-transition {
  navigation: none;
}
```

### CSP

The rule is an inline `<style>`. Under a `style-src` without
`'unsafe-inline'`, return `styleNonce` from your shell `head()` — the same
nonce that covers pracht's other generated styles. Prerendered (SSG/ISG) pages
cannot carry a per-request nonce; allow the rule by its hash instead, which
never changes:

```
style-src 'self' 'sha256-SREix9zPMZHrSuo8zRSjb672r1gsHIh96MJuaZq6iJo='
```

---

## Named Element Transitions

For shared-element style transitions, give the matching elements on both
routes the same `view-transition-name`.

<!-- snippet: partial -->
```tsx [src/routes/gallery.tsx]
<Link route="photo" params={{ id: photo.id }} viewTransition>
  <img
    src={photo.thumbnail}
    alt={photo.title}
    style={{ viewTransitionName: `photo-${photo.id}` }}
  />
</Link>
```

```tsx [src/routes/photo.tsx]
export function Component({ data }) {
  return (
    <article>
      <img
        src={data.photo.image}
        alt={data.photo.title}
        style={{ viewTransitionName: `photo-${data.photo.id}` }}
      />
      <h1>{data.photo.title}</h1>
    </article>
  );
}
```

Each `view-transition-name` must be unique in the rendered page. If a grid can
render the same photo twice, include enough context in the name to keep it
unique.

---

## Loading, Prefetching, And Scroll

Pracht resolves the target route first: route-state data is fetched and the
route and shell modules are imported before the DOM commit is wrapped in a view
transition. Redirects, loader errors, and full document fallbacks keep their
normal behavior.

That means slow data still makes the user wait before the transition starts.
Use prefetching for destinations that should feel immediate:

<!-- snippet: partial -->
```tsx
<Link route="photo" params={{ id: photo.id }} prefetch="render" viewTransition>
  Open photo
</Link>
```

For longer navigations, pair the transition with `useNavigation()` so the
current page can show pending state while the next page loads:

```tsx
import { useNavigation } from "@pracht/core";

export function TopProgress() {
  const navigation = useNavigation();

  return (
    <div
      class={navigation.state === "idle" ? "top-progress" : "top-progress active"}
      aria-hidden="true"
    />
  );
}
```

Scroll restoration still runs after the route commit. Forward navigations
scroll to the top or the target hash by default, and
`navigate(to, { preserveScroll: true })` keeps the current scroll position for
that navigation.

---

## Progressive Enhancement

You do not need a support check before using `viewTransition`. Browsers without
`document.startViewTransition()` commit the navigation normally, and browsers
without cross-document view transitions ignore the `@view-transition` rule and
simply load the next page.

Keep animations behind `prefers-reduced-motion: no-preference`, and avoid
putting critical state changes only in the animation. The page should be
correct whether the transition runs, is skipped, or is interrupted by a newer
navigation.

The browser's default cross-fade runs even when your stylesheet defines no
animation. To drop every transition for users who ask for reduced motion, turn
off cross-document transitions and the animations of same-document ones in a
stylesheet every page loads:

```css [src/styles/global.css]
@media (prefers-reduced-motion: reduce) {
  @view-transition {
    navigation: none;
  }

  ::view-transition-group(*),
  ::view-transition-old(*),
  ::view-transition-new(*) {
    animation: none !important;
  }
}
```
