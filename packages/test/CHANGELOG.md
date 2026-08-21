# @pracht/test

## 0.1.1

### Patch Changes

- Updated dependencies [[`65dad4f`](https://github.com/JoviDeCroock/pracht/commit/65dad4fad8a0bcd491f3dbf0164a5d6a7832c61a), [`a6f7969`](https://github.com/JoviDeCroock/pracht/commit/a6f79699384d022a756ab8beb5bb8ab6f892c6fd), [`c958be8`](https://github.com/JoviDeCroock/pracht/commit/c958be853668676e9b661e8e7df104af1e89a55d), [`8023263`](https://github.com/JoviDeCroock/pracht/commit/80232631288f4d9c64dbe4a0b8ff278bd5ece59c), [`6695d21`](https://github.com/JoviDeCroock/pracht/commit/6695d2125dce74eebee237c8f707a0b4b85a3480), [`098302d`](https://github.com/JoviDeCroock/pracht/commit/098302d8ab3d50151cd5964ef8a3a330f8a1b305), [`3ab3c02`](https://github.com/JoviDeCroock/pracht/commit/3ab3c0258e1b531265bb37cd0d2798800a12b75a)]:
  - @pracht/core@0.14.0

## 0.1.0

### Minor Changes

- [#294](https://github.com/JoviDeCroock/pracht/pull/294) [`9d56146`](https://github.com/JoviDeCroock/pracht/commit/9d56146212579c31e94ea3fa148318459bde42f7) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - New package: `@pracht/test` — first-party testing utilities for pracht apps.
  Until now the testing docs told users to hand-build `{ request, params, url,
  signal }` objects for every loader, API handler, and middleware test; this
  package ships small, typed factories and runners instead. `createLoaderArgs()`,
  `createApiArgs()`, and `createMiddlewareArgs()` build complete args objects
  from a shorthand (`url`, `method`, `headers`, a JSON-encoding `body`,
  `params`, a partial `context`, `route` overrides) or a real `Request`, derive
  `url` from the request, and expose the `AbortController` behind `signal` for
  cancellation tests. Blob/File and `URLSearchParams` bodies are normalized so
  the factories also work when JSDOM owns those values and Node owns `Request`;
  foreign-realm `FormData` and `ArrayBuffer` bodies retain their wire encoding
  instead of falling through to JSON serialization.
  `runMiddleware()` executes one middleware or a chain with
  the runtime's exact `next()` semantics — sequential dispatch, at-most-once
  `next()`, short-circuit on an early `Response`, a thrown `Response` resolving
  by default like page/API dispatch, opt-in raw-chain rejection for capability
  middleware, a fresh top-level args wrapper per dispatch with shared request
  state, and fail loudly on a non-`Response` return — so auth gates and
  context-augmenting middleware are unit-testable without hiding the capability
  pipeline's different `internal_error` behavior. `submitForm()` (with async
  `createFormRequest()`) builds a urlencoded or multipart form `POST` from
  realm-neutral text/bytes — including when JSDOM
  owns `File`/`FormData` and Node owns `Request` — auto-switches to multipart
  when a field is a `File`, and calls an API handler with it, exercising the
  same `FormData` parsing path `defineApi()` applies to real submissions;
  `method: "GET"` serializes the fields into the URL query string like a browser
  `<form method="get">`, exercising a `query` schema instead. Field names and
  string values use the browser form algorithm's CRLF newline normalization in
  URL-encoded, multipart, and query submissions. `ReadableStream`
  bodies get the required `duplex` option automatically.
  `readJson()` and `readRedirect()` are minimal response readers: parse a JSON
  body without consuming the original response, or extract
  `{ status, location }` from a redirect. No capability harness is included:
  `createCapabilityTestHost()` from `@pracht/core/server` already runs the real
  capability dispatch pipeline in-process.
  
  `MiddlewareArgs.route` now reflects the runtime contract: middleware can wrap
  either a page `ResolvedRoute` or an API `ResolvedApiRoute`. `@pracht/test`
  provides `createApiMiddlewareArgs()` for the API shape, while
  `createMiddlewareArgs()` remains the page-route factory.

### Patch Changes

- Updated dependencies [[`8bda980`](https://github.com/JoviDeCroock/pracht/commit/8bda98077404cb45d2d664ba70842a5034a913ae), [`1449857`](https://github.com/JoviDeCroock/pracht/commit/14498576af39f9c4e00276128a0ce5f86da6fb6c), [`d589e05`](https://github.com/JoviDeCroock/pracht/commit/d589e057f8751e3ae0d1819770d1c46201e83a1f), [`2872dfa`](https://github.com/JoviDeCroock/pracht/commit/2872dfa12d289b0fcbd067cbbf05096f6350b68d), [`e0bd8a9`](https://github.com/JoviDeCroock/pracht/commit/e0bd8a928f8248664859d8ea0d9a9c78ae76e815), [`6caf395`](https://github.com/JoviDeCroock/pracht/commit/6caf395d38d7d621ec1a402bff5926d7f3bd19e9), [`7de4718`](https://github.com/JoviDeCroock/pracht/commit/7de4718761cb2fe1427f1a3c5ece8ffe6f2a1778), [`0cd2f78`](https://github.com/JoviDeCroock/pracht/commit/0cd2f782b8b3d31ae408c26f1d6069e689eeb9d6), [`ffd9383`](https://github.com/JoviDeCroock/pracht/commit/ffd93836654031488f2a19ad478fbff617dcf0a2), [`a6ae18e`](https://github.com/JoviDeCroock/pracht/commit/a6ae18ea6e5c74cd09ff05e1beac1687917da296), [`8bda980`](https://github.com/JoviDeCroock/pracht/commit/8bda98077404cb45d2d664ba70842a5034a913ae), [`f8bb0bf`](https://github.com/JoviDeCroock/pracht/commit/f8bb0bf7e01c255fcf29bf2661e9cb18d7222b24), [`8bda980`](https://github.com/JoviDeCroock/pracht/commit/8bda98077404cb45d2d664ba70842a5034a913ae), [`1449857`](https://github.com/JoviDeCroock/pracht/commit/14498576af39f9c4e00276128a0ce5f86da6fb6c), [`9d56146`](https://github.com/JoviDeCroock/pracht/commit/9d56146212579c31e94ea3fa148318459bde42f7), [`e37ff77`](https://github.com/JoviDeCroock/pracht/commit/e37ff770fa2900be90981ac59cbb870311e9ecad), [`b486764`](https://github.com/JoviDeCroock/pracht/commit/b48676405e57d93ab91dabb94f64c102774198cf), [`b486764`](https://github.com/JoviDeCroock/pracht/commit/b48676405e57d93ab91dabb94f64c102774198cf), [`24f412a`](https://github.com/JoviDeCroock/pracht/commit/24f412adaa6f790f6896a554ed6e180151fb5cfe), [`159f1a8`](https://github.com/JoviDeCroock/pracht/commit/159f1a848dc9727341f3e2adf227634e7fda6b5c), [`00f7982`](https://github.com/JoviDeCroock/pracht/commit/00f79826ade75bafbb334f6e5705391eaab49c92), [`d7a9c76`](https://github.com/JoviDeCroock/pracht/commit/d7a9c76d22058a8cf45de026ce52d2f4d61fd875), [`9058c8e`](https://github.com/JoviDeCroock/pracht/commit/9058c8e0c79a6888003cd804f8449ec0d3e57843), [`4b31b30`](https://github.com/JoviDeCroock/pracht/commit/4b31b305f563d509aec10ea1047d4af1ffb9268c), [`eb6bd81`](https://github.com/JoviDeCroock/pracht/commit/eb6bd81a757fe697edf04d73570245979de6ce04), [`14fce3b`](https://github.com/JoviDeCroock/pracht/commit/14fce3b22e25965dc047265221c5fb3ee18d3f35), [`61f9824`](https://github.com/JoviDeCroock/pracht/commit/61f9824a99b30324a0b5501044aebab473967df9)]:
  - @pracht/core@0.13.0
