import { tool } from "@alexkroman1/aai";

// "Stop." The CLIENT does the work (client.tsx's useEvent("stop")): it silences a notice
// that is playing, cancels whatever reply is coming and hangs up, so nothing the model
// writes after this call is ever heard. A reply here would just be the speaker talking
// back after being told to stop.

declare module "@alexkroman1/aai" {
  interface ClientEventMap {
    stop: Record<string, never>;
  }
}

export default tool({
  description:
    "Stop everything on the speaker: silences what it is saying and ends the " +
    "conversation. Use ONLY when the whole request is just 'stop', 'cancel', " +
    "'never mind', 'be quiet' or 'that's all', with nothing after it. Never for " +
    "cancelling something specific, such as reminders (that's cancel_reminders). " +
    "Say nothing after calling it.",
  execute(_args, ctx) {
    ctx.send("stop", {});
    return { stopped: true };
  },
});
