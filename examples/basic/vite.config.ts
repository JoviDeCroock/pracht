import { defineConfig } from "vite";
import { prachtOpenApi } from "@pracht/openapi/vite";
import { pracht } from "@pracht/vite-plugin";

type DeployTarget = "cloudflare" | "node" | "vercel";

async function resolveAdapter(target: DeployTarget) {
  if (target === "vercel") {
    const { vercelAdapter } = await import("@pracht/adapter-vercel");
    return vercelAdapter();
  }

  if (target === "cloudflare") {
    const { cloudflareAdapter } = await import("@pracht/adapter-cloudflare");
    return cloudflareAdapter();
  }

  const { nodeAdapter } = await import("@pracht/adapter-node");
  return nodeAdapter({ canonicalOrigin: process.env.PRACHT_ORIGIN });
}

export default defineConfig(async () => {
  const target = (process.env.PRACHT_ADAPTER ?? "node") as DeployTarget;
  const imageBackend =
    process.env.PRACHT_IMAGE_BACKEND ?? (target === "node" ? "node" : "passthrough");

  return {
    define: {
      __PRACHT_IMAGE_BACKEND__: JSON.stringify(imageBackend),
    },
    plugins: [
      pracht({
        adapter: await resolveAdapter(target),
        // API module paths stay identical across deployment targets so
        // `pracht typegen` produces one stable committed contract. The image
        // route selects its Node or portable implementation behind the
        // compile-time backend flag, allowing edge builds to drop Sharp.
        apiDir: "/src/api",
        llmsTxt: {
          title: "Pracht Example",
          description: "Example app for the pracht framework.",
        },
      }),
      prachtOpenApi({
        info: {
          title: "Pracht Example API",
          version: "1.0.0",
          description: "HTTP endpoints exposed by the basic Pracht example.",
        },
        ui: "scalar",
      }),
    ],
  };
});
