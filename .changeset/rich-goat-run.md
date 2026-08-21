---
"@alexkroman1/aai": patch
---

Stop leaking a world stream reader on every workflow progress poll: a cancel arriving before the DevKit's background connect resolved detached nothing, and a caught-up page polls once a second.
