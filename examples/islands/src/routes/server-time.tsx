import type { LoaderArgs, RouteComponentProps } from "@pracht/core";
import Counter from "../islands/Counter.tsx";

export function loader(_args: LoaderArgs) {
  return {
    renderedAt: new Date().toISOString(),
  };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  return (
    <section>
      <h1>SSR with islands</h1>
      <p data-testid="rendered-at">Rendered at: {data.renderedAt}</p>
      <Counter start={100} client="idle" />
    </section>
  );
}
