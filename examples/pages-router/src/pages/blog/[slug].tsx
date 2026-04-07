import type { LoaderArgs, RouteComponentProps, RouteParams } from "previte";

export const RENDER_MODE = "ssg";

const POSTS = [
  { slug: "hello-world", title: "Hello World" },
  { slug: "getting-started", title: "Getting Started" },
  { slug: "pages-router", title: "Pages Router" },
];

export function getStaticPaths(): RouteParams[] {
  return POSTS.map((p) => ({ slug: p.slug }));
}

export async function loader({ params }: LoaderArgs) {
  const post = POSTS.find((p) => p.slug === params.slug);
  return {
    slug: params.slug,
    title: post ? `Blog: ${post.title}` : `Blog: ${params.slug.replace(/-/g, " ")}`,
  };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  return (
    <section>
      <h1>{data.title}</h1>
      <p>
        You are reading the post with slug: <code>{data.slug}</code>
      </p>
    </section>
  );
}
