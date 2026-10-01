---
"@alexkroman1/aai": major
"aai-studio-server": patch
---

Session event names now follow one grammar, `<subject>.<verb>` with both segments camelCase. Six events are renamed, with no alias for the old names: `user-transcript.updated` → `userTranscript.updated`, `user-transcript.committed` → `userTranscript.committed`, `agent-transcript.updated` → `agentTranscript.updated`, `agent-transcript.committed` → `agentTranscript.committed`, `user-turn.exceeded` → `userTurn.exceeded`, and `session.timed-out` → `session.timedOut`. Rename the keys of an `agent({ events })` handler map, a dialog's `@` event names (`"@session.timedOut"`), `useEvent` / `eventsOf` / `isEvent` arguments, and any client code that matches on an event's `type`. Every other event name is unchanged. A unit test now fails on any session event name off the grammar.
