import { renderToString } from "preact-render-to-string";
import type { CapabilityFormErrorArgs } from "@pracht/capabilities";

/** Pure failure renderer: validation failed before capability middleware runs. */
export function invalidNoteForm({ request, feedback }: CapabilityFormErrorArgs): Response {
  return new Response(
    "<!doctype html>" +
      renderToString(
        <html lang="en">
          <head>
            <meta charset="utf-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <title>Check your note</title>
          </head>
          <body>
            <main>
              <h1>Check your note</h1>
              {feedback.formErrors.map((message) => (
                <p role="alert">{message}</p>
              ))}
              <form method="post" action={new URL(request.url).pathname}>
                <label for="note-title">Title</label>
                <input
                  id="note-title"
                  name="title"
                  value={feedback.values.title ?? ""}
                  aria-invalid={!!feedback.fieldErrors.title}
                  aria-describedby="title-errors"
                />
                <p id="title-errors" role="alert">
                  {feedback.fieldErrors.title?.join(" ")}
                </p>
                <label for="note-body">Body</label>
                <textarea id="note-body" name="body">
                  {feedback.values.body ?? ""}
                </textarea>
                <button type="submit">Create note</button>
              </form>
              <p>
                <a href="/notes">Back to notes</a>
              </p>
            </main>
          </body>
        </html>,
      ),
    { status: 400, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}
