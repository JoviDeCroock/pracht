export interface CapabilitySourceOptions {
  description: string;
  effect: "read" | "write" | "destructive";
  expose: string[];
  title: string;
}

/**
 * A capability module skeleton.
 *
 * `expose`, `effect`, and `input` are emitted as inline object/string literals
 * on purpose: the browser and WebMCP projections are built by static analysis,
 * which cannot follow an imported constant or a spread, and the build fails
 * when it cannot read them.
 */
export function buildCapabilityModuleSource(options: CapabilitySourceOptions): string {
  const exposeEntries = options.expose.map((transport) => `${transport}: true`).join(", ");

  return [
    'import { defineCapability, type CapabilityRunArgs } from "@pracht/capabilities";',
    "",
    "interface Input {",
    "  query: string;",
    "}",
    "",
    "export default defineCapability({",
    `  title: ${JSON.stringify(options.title)},`,
    `  description: ${JSON.stringify(options.description)},`,
    "  input: {",
    '    type: "object",',
    "    properties: {",
    '      query: { type: "string", minLength: 1 },',
    "    },",
    '    required: ["query"],',
    "    additionalProperties: false,",
    "  },",
    "  output: {",
    '    type: "object",',
    "    properties: {",
    '      result: { type: "string" },',
    "    },",
    '    required: ["result"],',
    "  },",
    `  effect: ${JSON.stringify(options.effect)},`,
    ...(exposeEntries
      ? [`  expose: { ${exposeEntries} },`]
      : ["  // Private by default — add `expose: { http: true }` to make it callable."]),
    "  async run({ input }: CapabilityRunArgs<Input>) {",
    "    return { result: input.query };",
    "  },",
    "});",
    "",
  ].join("\n");
}
