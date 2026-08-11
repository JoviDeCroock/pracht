throw new Error("API fixture initialization exploded");

export function GET() {
  return new Response("unreachable");
}
