export async function loader() {
  return new Response(null, {
    status: 302,
    headers: { location: "/docs/getting-started" },
  });
}

export function Component() {
  return null;
}
