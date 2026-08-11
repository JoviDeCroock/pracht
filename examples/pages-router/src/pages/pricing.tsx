import type { LoaderArgs, RouteComponentProps } from "@pracht/core";

export const RENDER_MODE = "isg";
export const REVALIDATE = 60;

export function loader(_args: LoaderArgs) {
  return { generatedAt: new Date().toISOString() };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  return (
    <main>
      <h1>Pricing</h1>
      <p>Generated at {data.generatedAt}</p>
    </main>
  );
}
