import type { LoaderArgs, RouteComponentProps } from "@pracht/core";

// Deliberately slow loader so e2e tests can observe the pending navigation
// state exposed through useNavigation().
export async function loader(_args: LoaderArgs) {
  await new Promise((resolve) => setTimeout(resolve, 600));
  return { message: "Slow loader finished" };
}

export function head() {
  return { title: "Slow page" };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  return (
    <section class="slow-page">
      <h1>Slow page</h1>
      <p>{data.message}</p>
      {/* Tall spacer so preserveScroll navigations have room to keep their
          scroll position after the commit. */}
      <div style={{ height: "3000px" }} />
    </section>
  );
}
