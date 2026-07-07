# @pracht/adapter-deno

Deno adapter for Pracht apps.

```ts
import { denoAdapter } from "@pracht/adapter-deno";
import { pracht } from "@pracht/vite-plugin";

export default {
  plugins: [pracht({ adapter: denoAdapter() })],
};
```

Build and run with Deno:

```sh
pnpm pracht build
deno run --allow-net --allow-read=dist --allow-env=PORT dist/server/server.js
```

`pracht preview` runs the same server entry with the required Deno permissions.
