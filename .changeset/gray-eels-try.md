---
"aai-studio-server": patch
---

Studio actions no longer write into the chat: Publish, secret changes and the Database switch each posted a first-person user message into the conversation ("I set the secret X…", "I published the project with the Publish button…"). Each pane reports its own outcome instead — the Publish menu renders the CLI output, the Secrets card clears its draft only on success — and the coding agent's preamble now says it will not see a publish or a secret change rather than promising a note.
