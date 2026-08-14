export function toManifestModulePath(manifestPath: string, targetFilePath: string): string {
  const relativePath = targetFilePath
    .replaceAll("\\", "/")
    .replace(manifestPath.replaceAll("\\", "/").replace(/\/[^/]+$/, ""), "")
    .replace(/^\//, "");

  return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
}
