import { agent } from "@alexkroman1/aai";
import { notebookProjection } from "./shared.ts";

// A hold-to-talk notebook. The one line that makes it push-to-talk is
// `turnDetection: "manual"`: the CALLER ends each turn by letting go of the
// button (or the space bar), not the transcriber by hearing a pause. So a note
// can be dictated slowly, with as many pauses as thinking takes, and the agent
// neither cuts in nor answers half of it — and nothing said while the button
// is up reaches the transcriber at all, which is what a noisy site needs.
//
// `client.tsx` is the other half: `usePushToTalk()` from `@alexkroman1/aai-ui`
// turns a button into the three commands the runtime listens for.
export default agent({
  name: "Field Notes",
  description: "A hold-to-talk notebook: dictate across pauses, answered only when you let go",
  greeting:
    "Hold the button, or the space bar, and tell me what to write down. Take your time, I won't jump in until you let go.",
  turnDetection: "manual",
  // The notebook, pushed to the page after every tool call. The panel renders
  // `useAgentState(notebookProjection)` and keeps no copy of its own.
  syncState: notebookProjection,
});
