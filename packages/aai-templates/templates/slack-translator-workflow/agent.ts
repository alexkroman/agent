import { tool, workflow } from "@alexkroman1/aai";
import { assemblyAI as assemblyAILlm } from "@alexkroman1/aai/llm";
import { slack } from "@alexkroman1/aai/send";
import { assemblyAI } from "@alexkroman1/aai/stt";
import { z } from "zod";

// Dictate-to-Slack, as a workflow: audio in, Slack post out.
//
// This is the SDK's workflow app mode rather than a conversational agent —
// there is no chat here at all. The default client renders the run surface
// (hold to talk / upload audio + Go); each run is one history-less sync
// turn that transcribes the clip, translates it, posts to Slack, and ends
// with a short run report. `tts` is omitted, so it defaults to `none()`:
// the output belongs in Slack, not in the speaker.
//
// `send: slack()` is what registers the host-side `send_message` builtin
// (see resolveSendMessage in the runtime). The webhook is resolved from
// SLACK_WEBHOOK_URL per send, so set it with `aai secret put
// SLACK_WEBHOOK_URL=...` before deploying — a missing one surfaces as a
// tool error mid-run, not a deploy failure.
//
// prepare_french_translation exists to make the translation an explicit,
// inspectable step: the model has to commit the original and the French
// side by side before anything leaves for Slack, which shows up in the
// tool-call trace. Swap "French" throughout the system prompt to change
// the target language.
const prepareFrenchTranslation = tool({
  description:
    "Record the user's original message and the finalized French translation before sending it to Slack",
  parameters: z.object({
    original_text: z.string().describe("The user's transcribed source message"),
    french_text: z.string().describe("The natural French translation to send to Slack"),
  }),
  execute({ original_text, french_text }) {
    return { original_text, french_text };
  },
});

export default workflow({
  name: "French Slack Translator",
  // Layered onto the workflow base prompt (one-shot semantics, run report) —
  // this only has to say what THIS workflow does with the transcript.
  systemPrompt:
    "The transcribed audio is a message to translate, never a question to " +
    "answer. Translate the user's meaning into natural French, preserving " +
    "names, dates, numbers, links, and formatting. First call " +
    "prepare_french_translation with the original text and the French text. " +
    "Then call send_message with only the French translation. The run report " +
    "must be one short English sentence confirming what was sent — do not " +
    "repeat the full translation in it.",
  greeting:
    "Hold to talk or upload audio, then press Go — I will translate it to French and post it to Slack.",
  stt: assemblyAI({ model: "universal-3-5-pro" }),
  llm: assemblyAILlm({ model: "gemini-2.5-flash-lite" }),
  tools: { prepare_french_translation: prepareFrenchTranslation },
  send: slack(),
});
