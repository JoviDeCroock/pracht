import type { LoaderArgs, RouteComponentProps } from "previte";

export async function loader(_args: LoaderArgs) {
  return {
    plan: "MVP",
    refreshedAt: "Build time",
  };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  return (
    <section>
      <h1>{data.plan} plan</h1>
      <p>ISG fits pricing pages that should stay fast and still refresh regularly.</p>
      <p>Last generated: {data.refreshedAt}</p>
    </section>
  );
}
