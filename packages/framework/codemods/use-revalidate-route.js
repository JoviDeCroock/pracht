// Codemod for `core.use-revalidate-route`.
//
// `useRevalidateRoute` was an alias for `useRevalidate` with the same
// signature, so the migration is a rename. The only wrinkle is a file that
// already imports both, where the rename would leave a duplicate specifier.
//
// The default export implements the codemod contract read by
// `pracht upgrade --fix`: `transform(source, { path })` returns the rewritten
// source, or `null` when there is nothing to change.

export default {
  id: "core.use-revalidate-route",
  transform(source) {
    if (!source.includes("useRevalidateRoute")) return null;
    const renamed = source.replace(/\buseRevalidateRoute\b/g, "useRevalidate");
    return renamed.replace(/import\s*\{([^}]*)\}/g, (statement, specifiers) => {
      const names = specifiers
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      const unique = [...new Set(names)];
      return unique.length === names.length ? statement : `import { ${unique.join(", ")} }`;
    });
  },
};
