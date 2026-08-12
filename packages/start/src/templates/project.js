export function createPackageJson({ adapter, projectName, tailwind, versions }) {
  const scripts = {
    build: "pracht build",
    dev: "pracht dev",
    typecheck: "tsc --noEmit",
  };

  if (adapter.id === "node") {
    scripts.preview = "pracht preview";
    scripts.start = "node dist/server/server.js";
  }

  const devDependencies = {
    "@pracht/cli": versions["@pracht/cli"],
    "@pracht/vite-plugin": versions["@pracht/vite-plugin"],
    preact: "^10.26.9",
    "preact-render-to-string": "^6.5.13",
    typescript: versions["typescript"],
    vite: "^8.0.0",
  };

  if (adapter.id === "cloudflare") {
    scripts.deploy = "pracht build && wrangler deploy";
    scripts.preview = "pracht preview";
    devDependencies.wrangler = "^4.81.0";
  }

  if (adapter.id === "netlify") {
    scripts.deploy = "netlify deploy --build --prod";
    scripts.preview = "pracht build && netlify dev";
    devDependencies["netlify-cli"] = versions["netlify-cli"];
  }

  if (adapter.id === "vercel") {
    scripts.deploy = "pracht build && vercel deploy --prebuilt";
    devDependencies.vercel = versions["vercel"];
  }

  if (tailwind) {
    devDependencies["@tailwindcss/vite"] = versions["@tailwindcss/vite"];
    devDependencies.tailwindcss = versions["tailwindcss"];
  }

  return `${JSON.stringify(
    {
      dependencies: {
        [adapter.packageName]: versions[adapter.packageName],
        "@pracht/core": versions["@pracht/core"],
      },
      devDependencies,
      name: projectName,
      private: true,
      scripts,
      type: "module",
      version: "0.0.0",
    },
    null,
    2,
  )}\n`;
}
