---
"aai-studio-server": patch
---

Studio: recover a chat turn sent to a spun-down sandbox instead of failing it. The chat transport now targets the project's current session lease per request and re-sends a turn once on the re-brokered sandbox, so a message typed into a tab whose sandbox had been idle-evicted lands instead of showing a fetch error until the page is reloaded.
