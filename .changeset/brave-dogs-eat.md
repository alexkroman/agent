---
"@alexkroman1/aai": patch
"aai-studio-server": patch
---

Split the agent authoring guide into a core AGENT_GUIDE.md (with a read-X-when-Y routing table) plus topic files in agent-guide/ that ship beside it in the SDK tarball; list every agent() field and the real CLI commands; generate SKILL.md's subpath list from the exports map. The studio prompt inlines the topic files after the core.
