// Browser-condition stub for `@pracht/core/env/server`. The pracht Vite
// plugin already fails the build when client code imports the server env
// entry; this stub is a runtime backstop for other bundlers so a leaked
// import fails loudly instead of silently reading `undefined`.

const MESSAGE =
  "[pracht] @pracht/core/env/server was imported in client code. serverEnv is " +
  "server-only — use publicEnv (PRACHT_PUBLIC_-prefixed variables) in code " +
  "that ships to the browser.";

export function setServerEnv(): void {
  throw new Error(MESSAGE);
}

export const serverEnv: Record<string, never> = new Proxy(
  Object.create(null) as Record<string, never>,
  {
    get() {
      throw new Error(MESSAGE);
    },
    has() {
      throw new Error(MESSAGE);
    },
    ownKeys() {
      throw new Error(MESSAGE);
    },
  },
);
