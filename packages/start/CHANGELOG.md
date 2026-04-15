# create-pracht

## 0.2.1

### Patch Changes

- [`628a3e2`](https://github.com/JoviDeCroock/pracht/commit/628a3e27c78ffd11d8ab3ee34da8e77e5e7a7a3e) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add MIT license metadata and LICENSE files to all published packages.

## 0.2.0

### Minor Changes

- [#68](https://github.com/JoviDeCroock/pracht/pull/68) [`359af55`](https://github.com/JoviDeCroock/pracht/commit/359af5506dd6b3baf76d4020471275d95b445302) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Generate AGENTS.md and CLAUDE.md symlink in scaffolded projects describing project structure, commands, and scaffolding CLI usage

- [#66](https://github.com/JoviDeCroock/pracht/pull/66) [`c27ab9a`](https://github.com/JoviDeCroock/pracht/commit/c27ab9a3cfaa8706c9fb6f43de45511a12a7e524) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add non-interactive machine mode to create-pracht. New flags: `--yes`/`-y` (accept defaults, skip prompts), `--json` (JSON summary output), `--dry-run` (list files without writing). Invalid adapter or router values now exit with code 2.

### Patch Changes

- [#48](https://github.com/JoviDeCroock/pracht/pull/48) [`4520c16`](https://github.com/JoviDeCroock/pracht/commit/4520c168286e1c2716b49a4d744cc60fa9b25195) Thanks [@barelyhuman](https://github.com/barelyhuman)! - adds a tsconfig.json in the adapter starters

## 0.1.0

### Minor Changes

- [#25](https://github.com/JoviDeCroock/pracht/pull/25) [`f0ea0fb`](https://github.com/JoviDeCroock/pracht/commit/f0ea0fb0702fc65b2b68b63a4af2d722f11c2b60) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add router prompt to create-pracht CLI asking whether to use pages-router (file-system routing) or manifest (explicit routes.ts). Supports `--router=manifest|pages` flag.

### Patch Changes

- [#21](https://github.com/JoviDeCroock/pracht/pull/21) [`1243610`](https://github.com/JoviDeCroock/pracht/commit/12436100f9ce4a6dd749190570bf3b0dd1170308) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add README files to all packages

- [#22](https://github.com/JoviDeCroock/pracht/pull/22) [`e62e082`](https://github.com/JoviDeCroock/pracht/commit/e62e08293ba7a52c0d52437db37f5fd5db646252) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Resolve actual latest versions from the npm registry instead of inserting "latest" in scaffolded package.json
