import { notFound, useParams } from "@pracht/core";
import type { LoaderArgs, RouteComponentProps } from "@pracht/core";

const PRODUCTS: Record<string, { name: string; price: number }> = {
  "1": { name: "Widget", price: 9.99 },
  "2": { name: "Gadget", price: 19.99 },
};

export async function loader({ params }: LoaderArgs) {
  const product = PRODUCTS[params.id];
  if (!product) throw notFound("Product not found");
  return { product };
}

function ProductMeta() {
  const params = useParams();
  return <p class="product-id">Product ID: {params.id}</p>;
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  return (
    <section class="product-page">
      <ProductMeta />
      <h1>{data.product.name}</h1>
      <p class="product-price">${data.product.price}</p>
    </section>
  );
}
