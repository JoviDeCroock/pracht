import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";

type DeployTarget = "cloudflare" | "node" | "vercel";

async function resolveAdapter(target: DeployTarget) {
  if (target === "cloudflare") {
    const { cloudflareAdapter } = await import("@pracht/adapter-cloudflare");
    return cloudflareAdapter({ inspectorPort: false, persistState: false });
  }
  if (target === "vercel") {
    const { vercelAdapter } = await import("@pracht/adapter-vercel");
    return vercelAdapter();
  }
  const { nodeAdapter } = await import("@pracht/adapter-node");
  return nodeAdapter();
}

export default defineConfig(async () => {
  const target = (process.env.PRACHT_ADAPTER ?? "node") as DeployTarget;
  return {
    plugins: [
      pracht({
        pagesDir: "/src/pages",
        adapter: await resolveAdapter(target),
        llmsTxt: { title: "Pracht Pages Example" },
      }),
    ],
  };
});
