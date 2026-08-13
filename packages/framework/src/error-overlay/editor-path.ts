const WINDOWS_DRIVE_PATH = /^\/?[A-Za-z]:[\\/]/;

/**
 * Normalize a stack-frame path to a filesystem path that Vite's
 * `/__open-in-editor` endpoint can open. Handles `file://` URLs,
 * `http://` dev-server URLs, `/@fs/` prefixes, Vite query suffixes
 * (`?t=123`, `?pracht-client`), and root-relative dev URLs like
 * `/src/routes/home.tsx` (joined onto `root` when provided).
 */
export function normalizeStackFile(rawPath: string, root?: string): string | undefined {
  let path = rawPath;

  if (path.startsWith("http://") || path.startsWith("https://") || path.startsWith("file://")) {
    try {
      const url = new URL(path);
      path = decodeURIComponent(url.pathname);
    } catch {
      return undefined;
    }
  }

  // Strip Vite transform queries and hashes (`/src/a.tsx?t=123`).
  path = path.split("?")[0].split("#")[0];

  if (path.startsWith("/@fs/")) path = path.slice("/@fs".length);

  // `file://C:/...` and `/@fs/C:/...` leave a spurious leading slash on Windows.
  if (WINDOWS_DRIVE_PATH.test(path) && path.startsWith("/")) path = path.slice(1);

  if (!path) return undefined;

  // Root-relative dev-server URL (e.g. `/src/routes/home.tsx`): join onto
  // the project root so launch-editor resolves the real file. Paths already
  // under the root (or Windows drive paths) are absolute filesystem paths.
  if (root && path.startsWith("/") && !WINDOWS_DRIVE_PATH.test(path)) {
    const normalizedRoot = normalizeRoot(root);
    if (path !== normalizedRoot && !path.startsWith(`${normalizedRoot}/`)) {
      return `${normalizedRoot}${path}`;
    }
  }

  return path;
}

/**
 * Resolve the `file` metadata option (typically a manifest-relative path
 * such as `./routes/home.tsx`) to a filesystem path for open-in-editor.
 */
export function resolveEditorFilePath(file: string, root: string | undefined): string | undefined {
  if (file.startsWith("./")) {
    if (!root) return undefined;
    // Manifest-relative paths are rooted at the src directory by convention.
    return `${normalizeRoot(root)}/src/${file.slice(2)}`;
  }

  if (file.startsWith("../")) {
    // Cannot resolve reliably without knowing the manifest location.
    return undefined;
  }

  return normalizeStackFile(file, root);
}

function normalizeRoot(root: string): string {
  return root.endsWith("/") ? root.slice(0, -1) : root;
}
