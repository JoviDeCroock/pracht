# @pracht/preact-ssr-precompile

## 0.1.3

### Patch Changes

- [#293](https://github.com/JoviDeCroock/pracht/pull/293) [`e37ff77`](https://github.com/JoviDeCroock/pracht/commit/e37ff770fa2900be90981ac59cbb870311e9ecad) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Widen the `preact` peer range to accept 11.x prereleases.
  
  The peer was `^10.0.0` (`^10.26.0` for the precompiler), so installing pracht
  alongside `preact@11.0.0-beta.x` or `11.0.0-rc.0` printed peer warnings on
  every install even though nothing was actually broken. The range is now
  `^10.0.0 || ^11.0.0-0`, matching what `preact-render-to-string` already
  declares.
  
  The only preact internals pracht touches are the `options` hooks in the
  dev-only hydration-mismatch warning, which is installed behind
  `import.meta.env.DEV` and degrades to silence if the hooks it taps are never
  called. The SSR precompiler's `jsxTemplate` / `jsxAttr` / `jsxEscape` helpers
  are still exported from `preact/jsx-runtime` in 11. CI still runs against
  preact 10 — 11 is permitted, not yet verified.

## 0.1.2

### Patch Changes

- [#168](https://github.com/JoviDeCroock/pracht/pull/168) [`846f475`](https://github.com/JoviDeCroock/pracht/commit/846f47598dd7d975210149717f5a29210fb9205d) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Serialize boolean `data-*` attributes through the Preact SSR precompile path the same way `preact-render-to-string` does, and expand JSX precompile coverage for upstream transform cases.

## 0.1.1

### Patch Changes

- [#140](https://github.com/JoviDeCroock/pracht/pull/140) [`6e7cb43`](https://github.com/JoviDeCroock/pracht/commit/6e7cb435cda4483566653da25bafa7fa0bcd10e0) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add the `precompileSsrJsx` opt-in flag to the Pracht Vite plugin and document/benchmark the Preact SSR JSX precompile transform.
