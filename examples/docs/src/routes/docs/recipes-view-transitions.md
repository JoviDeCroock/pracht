---
title: View Transitions
lead: Animate client-side route changes and full page loads with the browser View Transitions API while keeping pracht's data loading, scroll restoration, and fallback behavior intact.
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

The prop renders as a `data-pracht-view-transition` attribute on the anchor.

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

---

## Islands And Static Pages

Routes with `hydration: "islands"` or `"none"` do not load the client router,
so navigating to, from, or between them is a full page load. With
`viewTransitions: true`, every page pracht renders carries
`@view-transition { navigation: auto }` in its `<head>`, so supporting browsers
animate these page loads as cross-document view transitions. Link clicks, form
submissions, and back/forward animate; reloads do not. No JavaScript is added.

Navigations the client router handles, and islands pages swapped in by
[`client.islandsNavigation`](/docs/islands#client-side-navigation-between-islands-pages),
animate once through `document.startViewTransition()`. The same `::view-transition-*` CSS and
`view-transition-name` values drive both, so the
[named photo transition](#named-element-transitions) also works between islands
pages. Set those names in CSS or server-rendered `style` attributes so they are
present when the new page first renders.

To keep one page out of cross-document transitions, override the rule in a
stylesheet that page loads:

```css [src/routes/checkout.css]
@view-transition {
  navigation: none;
}
```

The rule is an inline `<style>`. Under a strict `style-src`, return
`styleNonce` from your shell `head()`, or allow it on prerendered pages with
`'sha256-SREix9zPMZHrSuo8zRSjb672r1gsHIh96MJuaZq6iJo='`. See
[Content Security Policy](/docs/recipes/csp#framework-generated-styles).

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

Pracht loads the target route's data and modules before the transition
starts. Redirects, loader errors, and full document fallbacks keep their
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
view transition support commit client navigations and load full pages normally.

Keep animations behind `prefers-reduced-motion: no-preference`, and avoid
putting critical state changes only in the animation. The page should be
correct whether the transition runs, is skipped, or is interrupted by a newer
navigation.

The browser's default cross-fade runs even without your CSS. To turn every
transition off for users who prefer reduced motion, add this to a stylesheet
every page loads:

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
