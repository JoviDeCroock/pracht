---
"create-pracht": patch
---

Generate a narrow, version-appropriate build-script allowlist in `pnpm-workspace.yaml` so pnpm 10 and 11 dependency installs honor the policy without a separate approval step. Standalone configs include the starter itself and allow only the required esbuild, workerd, and optional Tailwind native build; apps inside a covering pnpm workspace instead receive version-correct root-policy guidance without creating a nested workspace.
