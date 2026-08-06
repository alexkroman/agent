---
"@alexkroman1/aai": patch
---

Pipeline mode: hold `speech_started` back while the agent is speaking, so the event means "the user took the floor and the agent is yielding" on both transports instead of "STT saw a word". Previously any one-word partial — a cough, a backchannel, a phrase addressed to someone else in the room — announced an interruption the barge-in gates then correctly declined to make, leaving clients that act on the event (tau2-bench discards its whole agent playout buffer on it, and has no `cancelled` handler) silencing a reply the agent was still speaking.
