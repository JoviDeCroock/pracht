import { kv } from "void/kv";

export async function GET() {
  return Response.json({
    value: await kv.get("pracht:helper"),
  });
}
