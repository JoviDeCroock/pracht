---
"@pracht/adapter-node": patch
---

Node ISG renders no longer see the triggering visitor's cookies or credentials, so a personalized `createContext` cannot leak one visitor's page into the shared snapshot. On ISG renders `createContext` receives a detached `req`/`res` that carries only the sanitized request's headers.
