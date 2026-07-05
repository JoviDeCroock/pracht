---
"create-pracht": minor
---

Polish the starter CLI:

- Add a Tailwind CSS option — a yes/no prompt plus `--tailwind` / `--no-tailwind` flags — that wires `tailwindcss` and `@tailwindcss/vite` into `vite.config.ts`, generates `src/styles/global.css`, and imports it from the shell.
- Add a `--template=minimal|tailwind` flag as the non-interactive umbrella (minimal is the current output, tailwind adds the Tailwind wiring).
- Initialize a git repository with an "Initial commit from create-pracht" commit after scaffolding, skipped with `--no-git`, when git is unavailable, or when the target directory is already inside a repository.
- Generate a multi-stage `Dockerfile` and `.dockerignore` for Node adapter scaffolds, and document `docker build` in the generated README.
