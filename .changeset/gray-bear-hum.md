---
"@alexkroman1/aai": patch
---

Add experimental `assemblyAIExperimentalStt()` (on
`@alexkroman1/aai/experimental`): runs a request/response transcription model on
AssemblyAI's transcribe endpoint (`POST /v1/transcribe`, default
`nemotron-3-5-transcribe`) as a pipeline STT stage, with host-side turn
segmentation on a level gate.
