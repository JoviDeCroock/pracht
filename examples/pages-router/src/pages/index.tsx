import { Link, useNavigate } from "@pracht/core";
import type { LoaderArgs, RouteComponentProps } from "@pracht/core";
import { href } from "../pracht-routes";

export const RENDER_MODE = "ssg";

export async function loader(_args: LoaderArgs) {
  return {
    message: "Welcome to pracht with file-system routing!",
  };
}

function TypedBlogButton() {
  const navigate = useNavigate();

  return (
    <button
      id="typed-blog-button"
      type="button"
      onClick={() => {
        void navigate({ route: "blog-slug", params: { slug: "my-first-post" } });
      }}
    >
      Open typed blog post
    </button>
  );
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  return (
    <section>
      <h1>{data.message}</h1>
      <p>This page uses the pages router with auto-discovered routes.</p>
      <p>
        <Link route="blog-slug" params={{ slug: "hello-world" }} search={{ ref: "typed-link" }}>
          Read typed blog post
        </Link>
      </p>
      <p>
        <a href={href("about", { search: { tab: "details" } })}>About via href()</a>
      </p>
      <TypedBlogButton />
    </section>
  );
}
