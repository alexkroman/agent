---
"@alexkroman1/aai-cli": patch
---

aai test now requires an agent project like every other project-scoped command: it was the one calling setup() without the agent guard, so in a directory with no agent.ts it found no test file, reported passed/skipped and exited 0 — a green result for a project that isn't there. And JSON mode now keeps its one-result-line stdout contract on citty's own argument errors: a missing positional or an unknown subcommand wrote a human usage block to stdout and no JSON at all, which is the normal scripted case since JSON mode is auto-detected on a pipe. The specific reason still goes to stderr, and --help is still the human block whatever the mode.
