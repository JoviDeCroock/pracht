---
title: View transitions
lead: Animate route changes and full page loads with the View Transitions API while keeping data loading and scroll restoration intact.
---

This recipe animates navigation from a photo grid to a photo page. View transitions are opt-in: pracht wraps the route commit in `document.startViewTransition()` where the browser supports it and commits a normal client navigation everywhere else, so you need no support check.

## 1. Mark the link

Add `viewTransition` to the `<Link>` whose navigation should animate:

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

The prop renders as a `data-pracht-view-transition` attribute on the anchor. Clicking a photo now cross-fades to the photo page in supporting browsers.

## 2. Style the animation

Control the animation with standard View Transitions CSS:

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

## 3. Add a named element transition

Give the matching elements on both routes the same `view-transition-name`, and the browser morphs one into the other. The grid above already names each thumbnail:

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

Use the same name on the photo page:

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

The thumbnail grows into the full image. Each `view-transition-name` must be unique in the rendered page; if a grid can render the same photo twice, put enough context in the name to keep it unique.

## Animate programmatic navigation

Pass `viewTransition` to `navigate()`:

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

## Enable app-wide

Set `viewTransitions: true` in the manifest to animate every client-side navigation:

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

Opt one programmatic navigation out so it commits immediately:

```ts
import { useNavigate } from "@pracht/core";

const navigate = useNavigate();

await navigate("/settings", { viewTransition: false });
```

## Islands and static pages

Routes with `hydration: "islands"` or `"none"` do not load the client router, so navigating to, from, or between them is a full page load. With `viewTransitions: true`, every page pracht renders carries `@view-transition { navigation: auto }` in its `<head>`, so supporting browsers animate these loads as cross-document view transitions without added JavaScript. Link clicks, form submissions, and back/forward animate; reloads do not.

Islands pages swapped in by [`client.islandsNavigation`](/docs/islands#client-side-navigation-between-islands-pages) animate through `document.startViewTransition()`, like client-router navigations. The same `::view-transition-*` CSS and `view-transition-name` values drive both, so the [named photo transition](#3-add-a-named-element-transition) also works between islands pages. Set those names in CSS or server-rendered `style` attributes so they exist when the new page first renders.

To keep one page out of cross-document transitions, override the rule in a stylesheet that page loads:

```css [src/routes/checkout.css]
@view-transition {
  navigation: none;
}
```

The rule is an inline `<style>`. Under a strict `style-src`, return `styleNonce` from your shell `head()`, or allow it on prerendered pages with `'sha256-SREix9zPMZHrSuo8zRSjb672r1gsHIh96MJuaZq6iJo='`. See [Content Security Policy](/docs/recipes/csp#framework-generated-styles).

## Loading, prefetching, and scroll

pracht loads the target route's data and modules before the transition starts, so slow data delays the animation. Redirects, loader errors, and full document fallbacks behave as without a transition.

Prefetch destinations that should feel immediate:

<!-- snippet: partial -->
```tsx
<Link route="photo" params={{ id: photo.id }} prefetch="render" viewTransition>
  Open photo
</Link>
```

For longer loads, show pending state on the current page with `useNavigation()`:

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

Scroll restoration runs after the route commit. Forward navigations scroll to the top or the target hash; `navigate(to, { preserveScroll: true })` keeps the current position for that navigation.

## Reduced motion

Keep animations behind `prefers-reduced-motion: no-preference`, and keep critical state changes out of the animation: the page must be correct whether the transition runs, is skipped, or is interrupted by a newer navigation.

The browser's default cross-fade runs even without your CSS. To turn every transition off for users who prefer reduced motion, add this to a stylesheet every page loads:

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
