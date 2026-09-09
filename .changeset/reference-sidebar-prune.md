---
"aai-docs": patch
---

Drop the SDK reference sidebar entries that led nowhere.

`starlight-typedoc` gives every module its own collapsible sidebar group and
fills it from the reflection groups — Functions, Classes, Interfaces — each of
which it expects to find as a directory of per-symbol pages. The site renders
one page per MODULE instead (`outputFileStrategy: "modules"`, so Pagefind
indexes 28 pages rather than ~780), so no such directory exists and all 24
module groups came out with zero children: under every package, a chevron that
expanded to nothing. That was most of what the reference's nav showed.

`pruneLinklessSidebarGroups()` in `docs/astro.config.mjs` removes every group
with no clickable descendant, leaving the reference root and one Overview per
package. Nothing becomes unreachable: each module page is still built, and each
package's Overview page ends in a Modules list linking to all of them — which
is also where the module's one-line description is, so it is the better place
to choose from.

It is a plugin rather than an edit to the sidebar array because the items are
computed inside `starlight-typedoc`'s own `config:setup` hook, and the group in
that array is still a placeholder when it is written; Starlight runs plugins in
order and hands each the config the previous ones left, so it sits after
`starlightTypeDoc()`. The rule is "no clickable descendants" rather than a list
of labels, so a future plugin version that fills those groups in keeps them,
and a no-op is announced as a build warning — that means either the generator
stopped emitting empty groups or the sidebar no longer has the shape being
walked, and the second one refills the nav with dead ends silently.
