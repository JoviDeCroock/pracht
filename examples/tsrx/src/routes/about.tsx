import type { LoaderArgs, RouteComponentProps } from "@pracht/core";

export async function loader(_args: LoaderArgs) {
  return {
    summary: "This is a regular .tsx route. The two file types coexist in the same Pracht app.",
  };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  return (
    <section>
      <h1>About this example</h1>
      <p>{data.summary}</p>
    </section>
  );
}
