---
"@alexkroman1/aai-cli": major
---

Rename the four `-desk` templates. The three that declare a durable workflow become `recap-workflow`, `research-workflow` and `transcription-workflow`, so the suffix says what the template demonstrates. `plan-desk` becomes `plan-and-execute` rather than `plan-workflow`: it declares no workflow at all — it is the LangGraph plan-and-execute port, a voice agent whose loop is driven one tool call at a time — so naming it after a mechanism it does not use would mislead, and naming it after the pattern it ports is what a reader arriving with that mental model will look for. `aai init -t <name>` and the studio's starter list take the new names; the agents' spoken greetings still say "desk", which is a thing a caller reaches rather than a template name.
