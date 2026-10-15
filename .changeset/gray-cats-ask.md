---
"@alexkroman1/aai-cli": patch
---

Template fixes from a live eval run: `meeting-recap-agent` no longer cancels and
restarts a running recap (which paid for a second transcription),
`executive-inbox-agent` says `edit` sends and keeps it for real changes to the
draft, and the pizza, quickstart, topic-briefing and tabletop RPG prompts cover
cases they left ambiguous.
