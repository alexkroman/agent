---
"@alexkroman1/aai-runtime": patch
---

eval: refuse a turn nothing about the agent can be read off. A turn the pipeline failed (a rejected credential, a provider error) is answered with errorPhrase, so a live refusal case passed against a rejected key; a scripted tool call naming a tool the agent does not declare emitted tool.called, never ran, and left result undefined. Both now fail the case, naming the provider error (an empty provider message reads as "(no message)") or the tools the agent really has. A suite whose every case is skipped by the mode gate now FAILS instead of exiting 0 green and empty, and every suite announces how many of its cases the chosen mode will run. A stubGenerate answer its own call's schema rejects is refused rather than handed back as a typed lie.
