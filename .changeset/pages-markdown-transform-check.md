---
"@pracht/cli": patch
---

Warn when a pages-router Markdown page has no transform plugin.

`docs/ROUTING.md` lists `.md` in the pages-router file-convention table and only
warns that **`.mdx`** needs a transform plugin. `.md` needs one too. Without it
the framework happily registers the route — it shows up in `pracht inspect
routes`, and `doctor` and `verify` both reported the app healthy — and then:

- the route 500s at request time with a raw parser error (`Parse failure:
  Invalid Character`), because Vite hands the Markdown to the JS parser, and
- `pracht build` exits 1 with an internal `RolldownError` stack.

`doctor` and `verify` now warn when a Markdown route is registered and the vite
config names no known Markdown transform plugin — in both routers (a `.md`
manifest route module breaks identically), for the not-found page as well as
ordinary routes, and under `--changed` scope, which is how you meet this in CI
right after adding the page. The docs state the requirement for both
extensions.

The check is a warning and says so: a custom or re-exported plugin is invisible
to a text match, so it reports "no *known* Markdown transform plugin" and tells
you to ignore it if you have one.
