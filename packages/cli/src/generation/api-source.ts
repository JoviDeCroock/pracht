import { quote } from "../utils.js";

export function buildApiRouteSource({
  endpointPath,
  methods,
}: {
  endpointPath: string;
  methods: string[];
}): string {
  const methodLines = methods.flatMap((method, index) => {
    const lines = buildApiMethodSource(method, methods, endpointPath);
    if (index === methods.length - 1) return lines;
    return [...lines, ""];
  });

  return ['import type { ApiRouteArgs } from "@pracht/core";', "", ...methodLines, ""].join("\n");
}

function buildApiMethodSource(method: string, methods: string[], endpointPath: string): string[] {
  if (method === "DELETE" || method === "HEAD") {
    return [
      `export function ${method}(_args: ApiRouteArgs) {`,
      "  return new Response(null, { status: 204 });",
      "}",
    ];
  }

  if (method === "OPTIONS") {
    return [
      `export function ${method}(_args: ApiRouteArgs) {`,
      "  return new Response(null, {",
      `    headers: { allow: ${quote(methods.join(", "))} },`,
      "    status: 204,",
      "  });",
      "}",
    ];
  }

  if (method === "GET") {
    return [
      `export function ${method}(_args: ApiRouteArgs) {`,
      `  return Response.json({ endpoint: ${quote(`/api${endpointPath}`)}, ok: true });`,
      "}",
    ];
  }

  const status = method === "POST" ? 201 : 200;
  return [
    `export async function ${method}({ request }: ApiRouteArgs) {`,
    "  const body = await request.json();",
    `  return Response.json({ body, ok: true }, { status: ${status} });`,
    "}",
  ];
}
