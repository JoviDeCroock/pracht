import { Form, type LoaderArgs, type RouteComponentProps } from "@pracht/core";

export async function loader({ url }: LoaderArgs) {
  const requested = url.searchParams.get("redirect") ?? "/dashboard";
  return {
    error: url.searchParams.get("error") === "1",
    // Reflecting an unvalidated `?redirect=` into the form would hand an
    // attacker an open redirect through a legitimate-looking login link.
    redirect: requested.startsWith("/") && !requested.startsWith("//") ? requested : "/dashboard",
  };
}

export function head() {
  return { title: "Log in — Pracht Example" };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  return (
    <section class="login">
      <h1>Log in</h1>
      {data.error && <p role="alert">Invalid email or password.</p>}
      <Form method="post" action="/api/auth/login">
        <input type="hidden" name="redirect" value={data.redirect} />
        <label>
          Email
          <input type="email" name="email" required defaultValue="ada@example.com" />
        </label>
        <label>
          Password
          <input type="password" name="password" required defaultValue="lovelace" />
        </label>
        <button type="submit">Log in</button>
      </Form>
      <p>
        Demo credentials are prefilled. See <code>src/server/users.ts</code>.
      </p>
    </section>
  );
}
