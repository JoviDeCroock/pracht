const FALLBACK_VERSION_RANGES = {
  "@pracht/adapter-cloudflare": "^0.5.8",
  "@pracht/adapter-netlify": "^0.1.0",
  "@pracht/adapter-node": "^0.3.8",
  "@pracht/adapter-vercel": "^0.2.8",
  "@pracht/cli": "^1.9.0",
  "@pracht/core": "^0.12.0",
  "@pracht/vite-plugin": "^0.7.6",
  "@tailwindcss/vite": "^4.1.0",
  "netlify-cli": "^21.6.0",
  tailwindcss: "^4.1.0",
  typescript: "^6.0.0",
  vercel: "^56.5.0",
};

export async function resolvePackageVersions(packageNames, { remote = true } = {}) {
  const entries = await Promise.all(
    packageNames.map(async (name) => {
      const fallback = FALLBACK_VERSION_RANGES[name] ?? "latest";
      if (!remote) return [name, fallback];
      try {
        return [name, `^${await fetchLatestVersion(name)}`];
      } catch {
        return [name, fallback];
      }
    }),
  );
  return Object.fromEntries(entries);
}

async function fetchLatestVersion(packageName) {
  const response = await fetch(`https://registry.npmjs.org/${packageName}/latest`);
  if (!response.ok) {
    throw new Error(`Failed to fetch version for ${packageName}: ${response.statusText}`);
  }
  const data = await response.json();
  return data.version;
}
