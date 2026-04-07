import { Form, useRevalidate, type LoaderArgs, type RouteComponentProps } from "viact";

export async function loader({ request }: LoaderArgs) {
  const hasSession = request.headers.get("cookie")?.includes("session=") ?? false;

  return {
    projectCount: hasSession ? 3 : 0,
    user: hasSession ? "Ada Lovelace" : "Guest",
  };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  const revalidate = useRevalidate();

  return (
    <section>
      <h1>{data.user}</h1>
      <p>Projects: {data.projectCount}</p>
      <Form method="post" action="/api/dashboard/refresh">
        <button type="submit" onClick={() => revalidate()}>Refresh dashboard</button>
      </Form>
    </section>
  );
}
