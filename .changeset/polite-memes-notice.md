---
"@alexkroman1/aai": patch
"@alexkroman1/aai-ui": patch
"@alexkroman1/aai-cli": patch
"@alexkroman1/aai-server": patch
---

BREAKING: Align SDK naming with S2S API

- `instructions` → `systemPrompt` in AgentOptions/AgentDef
- `DEFAULT_INSTRUCTIONS` → `DEFAULT_SYSTEM_PROMPT`
- `onTurn` → `onUserTranscript` hook
- Protocol events renamed: `transcript` → `user_transcript_delta`, `turn` → `user_transcript`, `chat` → `agent_transcript`, `chat_delta` → `agent_transcript_delta`, `tts_done` → `reply_done`, `tool_call_start` → `tool_call`
