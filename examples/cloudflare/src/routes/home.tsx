import { Link, useNavigate } from "@pracht/core";
import type { LoaderArgs, RouteComponentProps } from "@pracht/core";
import { href } from "../pracht-routes";

export async function loader(_args: LoaderArgs) {
  return {
    highlights: ["Hybrid route manifest", "Per-route rendering modes", "Thin deployment adapters"],
  };
}

function TypedProductButton() {
  const navigate = useNavigate();

  return (
    <button
      id="typed-product-button"
      type="button"
      onClick={() => {
        void navigate({ route: "product", params: { id: "2" }, search: { ref: "typed-button" } });
      }}
    >
      Open typed product
    </button>
  );
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  return (
    <section>
      <h1>Pracht starts with an explicit app manifest.</h1>
      <ul>
        {data.highlights.map((highlight) => (
          <li key={highlight}>{highlight}</li>
        ))}
      </ul>
      <p>
        <Link route="product" params={{ id: "1" }} search={{ ref: "typed-link" }}>
          View typed product
        </Link>
      </p>
      <p>
        <a href={href("pricing", { search: { ref: "typed-helper" } })}>Pricing via href()</a>
      </p>
      <p class="demo-links">
        <Link route="slow" prefetch="none" id="slow-link">
          Slow page
        </Link>{" "}
        <Link route="pricing" prefetch="intent" id="prefetch-pricing-link">
          Pricing (prefetch on intent)
        </Link>{" "}
        <Link route="pricing" viewTransition id="vt-pricing-link">
          Pricing (view transition)
        </Link>{" "}
        <Link route="long" id="long-link">
          Long page
        </Link>
      </p>
      <TypedProductButton />
    </section>
  );
}
