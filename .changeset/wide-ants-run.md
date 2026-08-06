---
"@alexkroman1/aai": patch
---

Send AssemblyAI voice_focus_threshold, defaulting to 0.9 (above the service's 0.7), so background speech stops reaching the transcript. Adds assemblyAIStt({ voiceFocusThreshold }).
