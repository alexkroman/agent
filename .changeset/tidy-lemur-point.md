---
"@alexkroman1/aai-cli": patch
"@alexkroman1/aai": patch
"aai-templates": patch
"aai-studio-server": patch
---

`aai init` no longer copies the 120KB authoring guide into the project. A scaffolded `CLAUDE.md` is now a ~30-line pointer at `node_modules/@alexkroman1/aai/AGENT_GUIDE.md` — the version-matched copy that ships in the SDK tarball, which the SDK's own skill has always named as the authoritative one.

The copy it replaces could not be right. It froze at the moment `aai init` ran and went stale on the project's next `pnpm update @alexkroman1/aai`, which is what `AGENT_GUIDE.md` exists to fix; and Claude Code loads a project-root `CLAUDE.md` in full at launch against a documented 200-line target, so every session in a user's agent project paid ~30k tokens for 2,533 lines of guidance whose own publisher told agents to prefer the other file. Splitting it behind an `@import` would not have helped — imports are expanded at launch too — so the pointer names the path in a fence, the documented spelling for "mention, do not import", and an agent reads it on demand out of the tarball the project actually resolved.

A scaffolded project is 21KB across 12 files instead of 136KB. Nothing else in `scaffold/` changed, a project's own `CLAUDE.md` still wins, and a template that ships one still has it copied — only the scaffold's guide is filtered.
