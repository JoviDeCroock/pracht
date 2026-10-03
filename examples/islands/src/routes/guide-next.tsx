import type { LoaderArgs, RouteComponentProps } from "@pracht/core";
import Counter from "../islands/Counter.tsx";

export function loader(_args: LoaderArgs) {
  return { renderedAt: new Date().toISOString() };
}

export function head() {
  return { title: "Next — Pracht Islands Example" };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  return (
    <section>
      <h1>Next page</h1>
      <p data-testid="rendered-at">Rendered at: {data.renderedAt}</p>
      <Counter start={1} />
    </section>
  );
}
