---
title: Your first shared operation
lead: Add a validated note through a human form and an agent call, protect both paths with the same session, and run the production build.
---

This walkthrough uses the runnable `examples/basic` app. You will turn its note creation operation into an authenticated, schema-validated operation shared by the page and browser agents. Its login, store, and form are already wired, so you can focus on the complete request flow.

The example uses a shared, in-memory notebook and demo credentials. Notes reset when the server restarts. Use your own user store and database when building a product.

## 1. Run the example

Use Node 22.18 or newer and pnpm 11:

```sh
git clone https://github.com/JoviDeCroock/pracht.git
cd pracht
pnpm install
pnpm build
cd examples/basic
export PRACHT_ORIGIN=http://localhost:3000
export SESSION_SECRET="$(openssl rand -base64 32)"
pnpm pracht dev
```

Open `http://localhost:3000/notes`. Create a note whose title contains “note”; the list refreshes after the successful submission. The page loader calls `notes.search`, and `<Form capability="notes.create">` posts to the same operation an agent can call.

## 2. Share a validation schema

Add this file. Zod is already installed in the example:

```ts [src/schemas/notes.ts]
import * as z from "zod";

export const createNoteInput = z.object({
  title: z.string().trim().min(1).max(120),
  body: z.string().max(2000).default(""),
});

export const createNoteOutput = z.object({
  note: z.object({
    id: z.string(),
    title: z.string(),
    body: z.string(),
  }),
});
```

Replace `src/capabilities/notes-create.ts` with:

```ts [src/capabilities/notes-create.ts]
import { defineCapability } from "@pracht/capabilities";
import { createNoteInput, createNoteOutput } from "../schemas/notes.ts";
import { createNote } from "../server/notes-store.ts";

export default defineCapability({
  title: "Create note",
  description: "Add a note to the shared example notebook.",
  input: createNoteInput,
  output: createNoteOutput,
  effect: "write",
  middleware: ["auth"],
  expose: { http: true, webmcp: true },
  async run({ input }) {
    return { note: createNote(input.title, input.body) };
  },
});
```

The schema infers `input` in the handler and supplies the JSON Schema agents receive. The operation keeps one business handler for form, HTTP, and WebMCP calls. `middleware: ["auth"]` applies the example's existing session gate to the operation itself.

## 3. Protect the page and attach its tools

In `src/routes.ts`, replace only the existing `/notes` route:

<!-- snippet: partial -->
```ts
route("/notes", () => import("./routes/notes.tsx"), {
  id: "notes",
  render: "ssr",
  middleware: ["auth"],
  capabilities: ["notes.search", "notes.create"],
}),
```

The page and operation each name their middleware. Protecting a page does not protect a capability endpoint. The example's search operation remains public because it searches the shared demo notebook.

Add `/notes` to the existing `llmsTxt.exclude` array in `vite.config.ts`, alongside `/dashboard` and `/settings`. Authenticated pages should not be advertised as anonymously readable content.

Run this in another terminal from `examples/basic`:

```sh
pnpm typegen
pnpm typecheck
```

Visit `/notes` in a private browser window. It sends you to `/login`. Sign in with the prefilled `ada@example.com` / `lovelace` demo account, then return to `/notes`.

## 4. Use the human form

The existing page already contains the form below; you do not need a new API route:

<!-- snippet: partial -->
```tsx
<Form
  capability="notes.create"
  onCapabilityResult={(result) => {
    setStatus(result.ok ? "Saved" : result.error.message);
  }}
>
  <input name="title" placeholder="Note title" />
  <input type="hidden" name="body" value="Created from the browser." />
  <button type="submit">Create note</button>
</Form>
```

Create “A note from the form”. The operation writes it, the framework revalidates the loader, and the list shows it. Try a title longer than 120 characters: the existing status paragraph displays the server's error message. Change the title and submit again.

Without JavaScript, a successful form POST redirects back to the page. For custom field feedback and native form failure responses, follow the [Forms recipe](/docs/recipes/forms).

## 5. Call the same operation as a tool

A WebMCP-compatible browser agent on `/notes` discovers `notes.search` and `notes.create` as page tools. Ask it to create “A note from an agent”, then reload the page to observe the stored note. It uses the signed-in browser session and the same validation and middleware as the form.

You can also exercise the HTTP projection directly. In another terminal, sign in and retain the session in a temporary cookie jar:

```sh
cookie_jar=$(mktemp)
curl -sS -c "$cookie_jar" -o /dev/null \
  --data-urlencode 'email=ada@example.com' \
  --data-urlencode 'password=lovelace' \
  http://localhost:3000/api/auth/login

curl -sS -b "$cookie_jar" \
  -H 'Origin: http://localhost:3000' \
  -H 'Content-Type: application/json' \
  -d '{"title":"A note from HTTP","body":"One shared operation."}' \
  http://localhost:3000/api/capabilities/notes/create
rm "$cookie_jar"
```

The result contains `ok: true` and the created note. Reload `/notes` to see it. A request without that session receives the auth gate's error response. Remote agents without a browser session use a different authentication setup; see [Remote MCP](/docs/mcp-tools).

## 6. Build and run production locally

Stop the dev server, then run:

```sh
pnpm pracht build
node dist/server/server.js
```

Keep `PRACHT_ORIGIN` and `SESSION_SECRET` set in that terminal. Sign in again if you changed the secret, create another note, and check the same UI and HTTP paths against the production server.

For your own app, start with [Quick start](/docs/getting-started), copy the schema/capability/form pattern, and add [session authentication](/docs/recipes/auth). The [deployment guide](/docs/deployment) covers publishing to your host with a persistent database and your own users.
