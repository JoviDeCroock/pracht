import type { LoaderArgs, RouteComponentProps, RouteParams } from "previte";

const PRODUCTS = [
  { id: "1", name: "Widget", price: "$9.99" },
  { id: "2", name: "Gadget", price: "$19.99" },
  { id: "3", name: "Doohickey", price: "$4.99" },
];

export function getStaticPaths(): RouteParams[] {
  return PRODUCTS.map((p) => ({ productId: p.id }));
}

export function loader({ params }: LoaderArgs) {
  const product = PRODUCTS.find((p) => p.id === params.productId);
  if (!product) throw new Error("Product not found");
  return product;
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  return (
    <div>
      <h1>{data.name}</h1>
      <p>Price: {data.price}</p>
    </div>
  );
}
