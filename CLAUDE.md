Always look at the vision_mvp and docs before starting work.
When you finish work update the docs and skills if needed.
When making changes that affect published packages, create a changeset (.changeset/<name>.md) describing the change. Use patch/minor/major as appropriate.
Before committing, always run `pnpm run verify`. It builds, formats, lints, then runs typecheck, test, and e2e in parallel, and prints output only for failing steps. Add `--skip-build` when dist is already current.
When creating a pull request, always follow .github/PULL_REQUEST_TEMPLATE.md and fill any non-applicable sections with N/A.
