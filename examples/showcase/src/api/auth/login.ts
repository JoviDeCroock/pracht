export function GET() {
  return new Response(null, {
    status: 303,
    headers: {
      location: "/app",
      "set-cookie": "session=demo; Path=/; HttpOnly; SameSite=Lax",
    },
  });
}
