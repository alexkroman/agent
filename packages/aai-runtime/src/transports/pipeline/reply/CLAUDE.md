---
summary: >-
  Pipeline replies: every code-initiated line states `{ record, interruptible }` and
  picks one of three placements
read_when: >-
  editing anything under `src/transports/pipeline/reply/`, or adding a line the
  pipeline speaks
---

# Pipeline reply

Stage map and import rules: [`../CLAUDE.md`](../CLAUDE.md).

## Every code-initiated line states `{ record, interruptible }`

`LineFlags` (`../../types.ts`) is the pair `speech.say()` takes, and every word
no model token produced states it. `lines.ts`'s module table lists each line,
its flags and its placement: a reply of its own (`createLineReply`), a failed
turn's last words (`speakFixedLine`), or INSIDE the reply in flight
(`speakInReply` — dead-air filler and tool messages, through the stream-part
handler's separator and transcript). Never spell a send for a new line; pick a
placement. The silence nudge and `notify` are model turns, not lines.
