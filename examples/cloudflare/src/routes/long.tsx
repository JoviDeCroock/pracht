import { Link } from "@pracht/core";

// Tall page used by e2e tests for scroll restoration and viewport prefetching.
export function Component() {
  return (
    <section class="long-page">
      <h1>Long page</h1>
      <p>
        <a href="/" id="long-home-link">
          Back home
        </a>
      </p>
      <div style={{ height: "3000px" }}>Tall content</div>
      <p>
        <Link route="pricing" prefetch="viewport" id="viewport-pricing-link">
          Pricing (viewport prefetch)
        </Link>
      </p>
    </section>
  );
}
