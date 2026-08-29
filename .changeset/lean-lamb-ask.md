---
"@alexkroman1/aai-cli": patch
---

`aai test` now names the project spec files it did not run, instead of skipping them silently — a scaffolded `retail` project reported 67 passing tests while 211 of its 278 never ran.
