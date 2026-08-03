---
"@alexkroman1/aai": minor
---

DX overhaul: rename the three assemblyAI stage factories to assemblyAIStt/assemblyAILlm/assemblyAITts (no aliases kept), brand provider descriptor types per stage so cross-stage assignment is a compile error, move cross-package infrastructure (createEpoch, createOwnedMap, parseWsUpgradeParams, env brands) off the root barrel onto @alexkroman1/aai/internal, drop the deprecated CustomEvent alias in aai-ui, document every public provider symbol, fix doc drift (AgentDef.llm descriptor wording, resumeSessionId persistence claim, ClientTheme defaults), add package READMEs, a real docs landing page, import-path module names in the API reference, aai templates command, and human-mode CliError hints.
