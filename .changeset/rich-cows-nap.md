---
"@alexkroman1/aai-cli": patch
---

Keep a failed log write from taking the dev server down: reporting a successful restart no longer sits inside the listen try/catch, where a throwing notifier (stderr closed by a piped `aai dev`) was reported as a failed listen and tore down a server that had already bound.
