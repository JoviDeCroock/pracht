export function GET() {
  return new Response(null, {
    status: 303,
    headers: {
      location: "/",
      "set-cookie": "session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
    },
  });
}
