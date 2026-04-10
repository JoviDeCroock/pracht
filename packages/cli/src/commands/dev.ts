import { defineCommand } from "citty";
import consola from "consola";

export const devCommand = defineCommand({
  meta: {
    name: "dev",
    description: "Start development server with HMR",
  },
  args: {
    port: {
      type: "positional",
      description: "Port to listen on",
      required: false,
    },
  },
  async run({ args }) {
    const { createServer } = await import("vite");

    const port = parseInt(process.env.PORT || args.port || "3000", 10);

    const server = await createServer({
      root: process.cwd(),
      server: { port },
    });

    await server.listen();
    consola.success(`Dev server running`);
    server.printUrls();
  },
});
