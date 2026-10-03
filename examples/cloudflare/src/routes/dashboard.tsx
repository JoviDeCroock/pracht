import {
  Form,
  useRevalidate,
  useShellData,
  type LoaderArgs,
  type RouteComponentProps,
} from "@pracht/core";

import type { loader as appShellLoader } from "../shells/app.tsx";

export async function loader({ request }: LoaderArgs) {
  const hasSession = request.headers.get("cookie")?.includes("session=") ?? false;

  return {
    projectCount: hasSession ? 3 : 0,
    user: hasSession ? "Ada Lovelace" : "Guest",
  };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  const revalidate = useRevalidate();
  const shell = useShellData<typeof appShellLoader>();

  return (
    <section>
      <h1>{data.user}</h1>
      <span class="route-shell-user">Signed in as {shell?.user}</span>
      <p>Projects: {data.projectCount}</p>
      <Form
        method="post"
        action="/api/dashboard"
        onSubmit={async () => {
          await revalidate();
        }}
      >
        <button type="submit">Revalidate dashboard</button>
      </Form>
    </section>
  );
}
