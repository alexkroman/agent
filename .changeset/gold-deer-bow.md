---
"@alexkroman1/aai": patch
"aai-server": patch
---

Simplify the SDK's mode and dialog plumbing. A dialog tool now refuses only in its own execute (the identical refusal the model already read), so Dialog.gate, DialogToolGate and ToolBearingDef.dialogs are removed. assertProviderTriple takes no text flag. A workflow app refusing s2s now calls it the speech-to-speech descriptor. Every server derives its front door from the agent's mode through one frontDoorOf.
