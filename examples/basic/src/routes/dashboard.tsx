import { Form, useRevalidate, type LoaderArgs, type RouteComponentProps } from "@pracht/core";

import type { SessionContext } from "../server/session.ts";

export async function loader({ context }: LoaderArgs<SessionContext>) {
  // The auth middleware already refused anonymous requests, so this reads a
  // session that is known to exist. `notice` is a flash value: reading it here
  // consumes it, and the middleware rewrites the cookie without it.
  return {
    notice: context.session.get("notice") ?? null,
    projectCount: 3,
    user: context.session.get("name") ?? "Guest",
  };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  const revalidate = useRevalidate();

  return (
    <section>
      <h1>{data.user}</h1>
      {data.notice && <p role="status">{data.notice}</p>}
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
      <Form method="post" action="/api/auth/logout">
        <button type="submit">Log out</button>
      </Form>
    </section>
  );
}
