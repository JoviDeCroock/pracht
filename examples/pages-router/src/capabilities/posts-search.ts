import { defineCapability } from "@pracht/capabilities";

const POSTS = [
  { slug: "hello-world", title: "Hello World" },
  { slug: "getting-started", title: "Getting Started" },
  { slug: "pages-router", title: "Pages Router" },
];

// Auto-discovered: every module in `src/capabilities/` is registered. The
// declared `name` maps back to this file (`posts.search` ↔ `posts-search.ts`),
// which is what lets the pages router key the registry by file.
export default defineCapability({
  name: "posts.search",
  title: "Search posts",
  description: "Find blog posts whose title or slug matches the query.",
  effect: "read",
  expose: { http: true, mcp: true },
  input: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1, description: "Text to search for." },
    },
    required: ["query"],
    additionalProperties: false,
  },
  output: {
    type: "object",
    properties: {
      posts: {
        type: "array",
        items: {
          type: "object",
          properties: { slug: { type: "string" }, title: { type: "string" } },
          required: ["slug", "title"],
          additionalProperties: false,
        },
      },
    },
    required: ["posts"],
    additionalProperties: false,
  },
  run({ input }: { input: { query: string } }) {
    const query = input.query.toLowerCase();
    return {
      posts: POSTS.filter(
        (post) =>
          post.title.toLowerCase().includes(query) || post.slug.toLowerCase().includes(query),
      ),
    };
  },
});
