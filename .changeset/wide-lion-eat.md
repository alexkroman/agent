---
"@alexkroman1/aai": minor
"aai-studio-server": minor
---

AssemblyAI streaming TTS now follows the documented API
(https://www.assemblyai.com/docs/tts): it dials
wss://tts.us.assemblyai.com/v1/ws (or tts.eu.assemblyai.com, which
assemblyAIPipeline({ region: "eu" }) now selects), sends voice_id instead of the
retired voice param, and splits Generate text at the 2000-character per-frame
cap, so a long stepSpeak no longer fails. Breaking: voices are voice_id slugs —
assemblyAITts({ voice: "aai-jane" }), not "jane" — and ASSEMBLYAI_TTS_VOICES is
now a tuple of the 11 library slugs, every one of which speaks all six
languages; ttsVoiceIds, ttsVoiceInfo and AssemblyAITtsVoiceInfo are removed (use
z.enum(ASSEMBLYAI_TTS_VOICES)), as is the voice/language mismatch check.
