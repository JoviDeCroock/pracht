export function pathParameters(path: string): Array<{ name: string; schemaName: string }> {
  const parameters: Array<{ name: string; schemaName: string }> = [];
  for (const segment of path.split("/")) {
    if (segment.startsWith(":")) {
      const name = segment.slice(1);
      parameters.push({ name, schemaName: name });
    }
    if (segment === "*") parameters.push({ name: "path", schemaName: "*" });
  }
  return parameters;
}

export function toOpenApiPath(path: string): string {
  return path
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":")) return `{${segment.slice(1)}}`;
      if (segment === "*") return "{path}";
      return segment;
    })
    .join("/");
}
