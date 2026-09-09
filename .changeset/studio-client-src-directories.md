---
"aai-studio-client": patch
"aai-studio-server": patch
---

Give the studio front-end a `components/` (29 files) and a `hooks/` (the three `use-*` modules); everything else stays at `src/` root.

The PANES deliberately do not move. konsistent's `studio-client-pane-modules` pins a thirteen-module roster as the statement of what the switcher renders, and that roster is a category rather than a subset of "components" — seven were moved into `components/`, the convention failed, and they came back. If they ever want a directory it should be `panes/`, with that convention's paths moved to match.

`studio-client-cleanup-is-setup` had to be widened to cover subdirectories, and that is the failure mode to check for on any move in this package: it forbids importing Testing Library's `cleanup`, keyed on `src/{suite}.test.tsx`, so moving nine specs into subdirectories dropped them from a rule that went on printing green — including `hooks/use-event-stream.test.ts`, the one file the convention's own rationale is written about. Both glob spellings are listed, since a konsistent `**` needs a subdirectory to match, and the widening was A/B'd by adding the forbidden import and watching the rule fire.
