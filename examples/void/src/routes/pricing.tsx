import type { LoaderArgs, RouteComponentProps } from "@pracht/core";

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
      <p>On Void, ISG routes are prerendered at build time and served as static assets.</p>
      <p>Last generated: {data.refreshedAt}</p>
    </section>
  );
}
