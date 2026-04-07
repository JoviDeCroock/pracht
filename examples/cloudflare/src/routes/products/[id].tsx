import { useParams } from "previte";
import type { LoaderArgs, RouteComponentProps } from "previte";

const PRODUCTS: Record<string, { name: string; price: number }> = {
  "1": { name: "Widget", price: 9.99 },
  "2": { name: "Gadget", price: 19.99 },
};

export async function loader({ params }: LoaderArgs) {
  const product = PRODUCTS[params.id];
  return { product: product ?? null };
}

function ProductMeta() {
  const params = useParams();
  return <p class="product-id">Product ID: {params.id}</p>;
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  return (
    <section class="product-page">
      <ProductMeta />
      {data.product ? (
        <>
          <h1>{data.product.name}</h1>
          <p class="product-price">${data.product.price}</p>
        </>
      ) : (
        <h1>Product not found</h1>
      )}
    </section>
  );
}
