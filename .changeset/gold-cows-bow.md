---
"@alexkroman1/aai": minor
---

`system-prompt.md` beside `agent.ts` IS the system prompt. The build discovers it, so an agent declares no `systemPrompt` and writes no import — a prompt is markdown, and inline it becomes that document spelled as escaped newlines inside one string literal, which diffs as a single line no matter which bullet changed. Declaring a DIFFERENT prompt while the file sits unread is a build error, because "I edited the prompt and nothing changed" is the silent-absence failure tool discovery exists to kill, pointing the other way; an empty file is an error too. Composing stays legal and is the one case you write the import — the build sees its own text inside your prompt and leaves what you built alone. `greeting` and `sttPrompt` stay fields: a document goes in a file, a value stays in the call.
