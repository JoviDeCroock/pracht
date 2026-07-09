---
title: View Transitions
lead: Animate client-side route changes with the browser View Transitions API while keeping pracht's data loading, scroll restoration, and fallback behavior intact.
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
const navigate = useNavigate();

await navigate("/settings", { viewTransition: false });
```

---

## Named Element Transitions

For shared-element style transitions, give the matching elements on both
routes the same `view-transition-name`.

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
`document.startViewTransition()` commit the navigation normally.

Keep animations behind `prefers-reduced-motion: no-preference`, and avoid
putting critical state changes only in the animation. The page should be
correct whether the transition runs, is skipped, or is interrupted by a newer
navigation.
