---
"aai-templates": patch
"@alexkroman1/aai-cli": patch
---

Give every voice template a one-click new-conversation control. The three templates that pass a custom `component:` render no `<Controls>`, so dispatch-center and retail had no way back to a fresh conversation without going through the start screen; each now carries its own button, and infocom-adventure's [N]ew Game deals a new game in one click with [Q]uit keeping the hang-up. A new case in template-page-mount.test.ts holds the line.
