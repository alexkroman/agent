---
"@alexkroman1/aai": minor
---

Add push-to-talk: `agent({ turnDetection: "manual" })` lets the CLIENT end each caller turn instead of a pause. The microphone reaches the transcriber only between the new `user_turn_start` and `user_turn_commit` / `user_turn_clear` session commands; everything said in that window is one turn, speech never barges in on its own, and opening a turn interrupts the agent. `aai-ui` adds `BrowserSession.startUserTurn` / `commitUserTurn` / `clearUserTurn` and the `usePushToTalk()` hook, and a new `push-to-talk-agent` template shows the whole loop. Pipeline mode only; the default (`"auto"`) is unchanged.
