---
"@alexkroman1/aai-ui": minor
---

Remember a workflow form's upload ids in sessionStorage, so a page reload resumes an interrupted upload instead of sending the file again. A recalled id is checked against the agent's own upload record before anything is sent to it: a complete upload skips the transfer entirely, an unfinished one with stored windows is resumed, and anything else gets a fresh id.
