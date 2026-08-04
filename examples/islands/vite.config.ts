import { defineConfig, type Plugin } from "vite";
import { pracht } from "@pracht/vite-plugin";
import { nodeAdapter } from "@pracht/adapter-node";
import { fileURLToPath } from "node:url";

// Content scanners such as Tailwind register every source they inspect as a
// file-only asset dependency of their CSS module. Model that through Vite's
// public addWatchFile hook so this example covers the same graph state without
// coupling the monorepo's Vite installation to optional peer dependencies.
function contentScannerFixture(): Plugin {
  const sourceFiles = ["./src/routes/home.tsx", "./src/routes/static-page.tsx"].map((path) =>
    fileURLToPath(new URL(path, import.meta.url)),
  );

  return {
    name: "pracht:e2e-content-scanner",
    transform(_, id) {
      if (!id.endsWith("/src/styles.css")) return;
      for (const file of sourceFiles) {
        this.addWatchFile(file);
      }
    },
  };
}

export default defineConfig({
  plugins: [contentScannerFixture(), pracht({ adapter: nodeAdapter() })],
});
