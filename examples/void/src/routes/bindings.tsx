import type { LoaderArgs, RouteComponentProps } from "@pracht/core";

interface VoidExampleContext {
  env: {
    KV?: {
      get(key: string): Promise<string | null>;
    };
  };
}

export async function loader({ context }: LoaderArgs) {
  const { env } = context as VoidExampleContext;
  const rawValue = (await env.KV?.get("pracht:raw")) ?? "missing";

  return {
    rawValue,
  };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  return (
    <section>
      <h1>Void bindings</h1>
      <p data-testid="raw-kv">Raw KV: {data.rawValue}</p>
    </section>
  );
}
