import type { LoaderArgs, RouteComponentProps } from "@pracht/core";
import Counter from "../islands/Counter.tsx";
import { DeadButton } from "../components/dead-button.tsx";

export async function loader(_args: LoaderArgs) {
  return {
    tagline: "Mostly static HTML with islands of interactivity.",
  };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  return (
    <section>
      <h1>Islands architecture</h1>
      <p>{data.tagline}</p>
      <Counter start={5} />
      <DeadButton />
    </section>
  );
}
