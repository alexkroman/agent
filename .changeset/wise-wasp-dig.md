---
"@alexkroman1/aai": patch
---

Log session.error code+message at warn level (was hidden — only the type was logged), capture session id from session.updated.config.id (the success-path message; session.ready is no longer sent there, leaving resume permanently disabled), and remove the broken time-since-session-ready check from canResumeAfter that prevented resume on any session older than 25s.
