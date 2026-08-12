import type { LoaderArgs, RouteComponentProps, RouteParams } from "@pracht/core";

const POSTS: Record<string, { title: string; body: string }> = {
  "hello-world": { title: "Hello world", body: "The first post." },
  "second-post": { title: "Second post", body: "Another build-time post." },
};

export function getStaticPaths(): RouteParams[] {
  return Object.keys(POSTS).map((slug) => ({ slug }));
}

export async function loader({ params }: LoaderArgs) {
  const post = POSTS[params.slug as string];
  return { post: post ?? null, slug: params.slug };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  if (!data.post) {
    return <p id="post-missing">Unknown post.</p>;
  }
  return (
    <article id="post">
      <h1>{data.post.title}</h1>
      <p>{data.post.body}</p>
      <a href="/posts/second-post">Next post</a>
    </article>
  );
}
