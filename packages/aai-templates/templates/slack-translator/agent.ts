import { agent, tool } from "@alexkroman1/aai";
import { assemblyAI as assemblyAILlm } from "@alexkroman1/aai/llm";
import { slack } from "@alexkroman1/aai/send";
import { assemblyAI } from "@alexkroman1/aai/stt";
import { none } from "@alexkroman1/aai/tts";
import { z } from "zod";

// Dictate-to-Slack: speech in, French out, posted to a channel.
//
// Text-only pipeline mode (`tts: none()`) — the reply belongs in Slack, not
// in the speaker, so there is no synthesis side at all. The default client
// makes the mic opt-in in this mode, so "hold to record, then read the
// confirmation" needs no custom client.tsx.
//
// `send: slack()` is what registers the host-side `send_message` builtin
// (see resolveSendMessage in the runtime). The webhook is resolved from
// SLACK_WEBHOOK_URL per send, so set it with `aai secret put
// SLACK_WEBHOOK_URL=...` before deploying — a missing one surfaces as a
// tool error mid-conversation, not a session-start failure.
//
// prepare_french_translation exists to make the translation an explicit,
// inspectable step: the model has to commit the original and the French
// side by side before anything leaves for Slack, which shows up in the
// transcript and in tool-call UI. Swap "French" throughout the system
// prompt to change the target language.
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

export default agent({
  name: "French Slack Translator",
  systemPrompt:
    "You turn push-to-talk messages into polished French and send them to " +
    "Slack. Treat each user message as text to translate unless they clearly " +
    "ask for help. Translate the user's meaning into natural French, " +
    "preserving names, dates, numbers, links, and formatting. For every " +
    "translation, first call prepare_french_translation with the original " +
    "text and French text. Then call send_message with only the French " +
    "translation. After it is sent, reply with one short confirmation in " +
    "English. Do not read the full translation back unless the user asks.",
  greeting: "Press record, say a message, and I will translate it to French and send it to Slack.",
  stt: assemblyAI({ model: "universal-3-5-pro" }),
  llm: assemblyAILlm({ model: "gemini-2.5-flash-lite" }),
  tts: none(),
  tools: { prepare_french_translation: prepareFrenchTranslation },
  send: slack(),
});
