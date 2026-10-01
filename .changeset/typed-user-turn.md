---
"@alexkroman1/aai": minor
"@alexkroman1/aai-runtime": minor
"@alexkroman1/aai-ui": minor
---

A user can now TYPE to a live voice session. `useSession().sendText(text)` (also on `useSessionActions()` and `BrowserSession`) sends a new `{ type: "user_text", text }` command, and the agent answers it exactly as if it had been spoken: it interrupts a reply in progress, is reported as the same `userTranscript.committed` a spoken turn produces (so it appears once in `messages`, in history, and on a resume — don't echo it locally), and the reply runs through tools and TTS as usual. It works under any `turnDetection`. Text is trimmed; empty text is not sent, and over 100,000 characters is refused. Pipeline agents only: a speech-to-speech session logs a warning once and ignores it.
