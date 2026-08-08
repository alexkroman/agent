---
"@alexkroman1/aai-cli": minor
---

Export the CLI's project-config writers as a public subpath (`@alexkroman1/aai-cli/project-config`), so the studio guest's Publish stops hand-writing the config home and the `.aai/project.json` pin with JSON.stringify. One writer per on-disk format keeps the 0600 atomic-rename write and the pin's merge semantics.
