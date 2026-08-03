import { defineConfig } from "vite";
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
        // The built-in image optimizer depends on sharp and is Node-only.
        // Edge builds keep the portable API routes but omit that endpoint.
        apiDir: target === "node" ? "/src/api" : "/src/api-edge",
        llmsTxt: {
          title: "Pracht Example",
          description: "Example app for the pracht framework.",
        },
      }),
    ],
  };
});
