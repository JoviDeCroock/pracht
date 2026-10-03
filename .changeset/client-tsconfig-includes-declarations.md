---
"create-pracht": patch
"@pracht/cli": patch
---

New apps' `tsconfig.client.json` now includes `src/**/*.d.ts`, so typed `useRouteData()`, `useSearch()`, and `<Link route>` are checked in client code, and `pracht doctor` warns when an existing app's client config leaves `src/pracht.d.ts` out.
