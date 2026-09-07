import { lazy, Suspense } from "@pracht/core";

export const RENDER_MODE = "ssr";

const LazyEmpty = lazy(() => import("./_components/lazy-empty.tsx"));
const LazyFragment = lazy(() => import("./_components/lazy-fragment.tsx"));

export function Component() {
  return (
    <section>
      <h1>Lazy hydration boundaries</h1>
      <Suspense fallback={<p>Loading lazy empty boundary</p>}>
        <LazyEmpty />
      </Suspense>
      <Suspense fallback={<p>Loading lazy fragment</p>}>
        <LazyFragment />
      </Suspense>
    </section>
  );
}
