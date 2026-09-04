---
"@alexkroman1/aai": minor
"@alexkroman1/aai-ui": minor
---

Publish seven more seams the templates had each re-derived: `formatMoney` (`@alexkroman1/aai/utils`), `ffmpegBaseArgs` (`/ffmpeg`), `routeStepFetch` (`/testing`), and `Session.restart()`, `WorkflowSubmission.startedHere`, `<BulletList>` and `<Facts>` (`@alexkroman1/aai-ui`).

Two are behaviour fixes rather than de-duplication. `Controls`' "New Conversation" button called `reset()`, which reconnects carrying the same session id — so on any agent with a `sessionSlot` the caller got a blank transcript in front of their old state; it calls `restart()` now. And `transcodeToWav` did not pass `-nostats`, so ffmpeg's progress output could evict the error explaining a failure out of the captured stderr tail.

`startedHere` is the fact only the hook can know — six pages kept a `useState(false)` beside it, set in their own `onSubmit` and mirrored in their `onClear`, to tell a run this page started from one the mount-time lookup adopted after a reload.

The published stylesheet now honours `prefers-reduced-motion: reduce`, which appeared nowhere in the repository before: roughly nineteen infinite animations ship in an aai app, and the universal selector is the only thing that reaches the keyframes a template declares in its own `<style>` block.
