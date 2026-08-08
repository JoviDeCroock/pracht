---
"create-pracht": minor
---

Scaffold a not-found page. New manifest apps get `src/routes/not-found.tsx` wired
through `defineApp({ notFound })`; pages-router apps get `src/pages/404.tsx`,
which pracht wires automatically. Previously the manifest only carried a
commented-out `notFound:` hint pointing at a file that was never generated, which
made `pracht doctor` report a missing module reference on a fresh scaffold.
