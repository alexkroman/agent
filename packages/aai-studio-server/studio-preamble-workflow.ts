// Copyright 2026 the AAI authors. MIT license.
/**
 * The WORKFLOW project's addition to the studio coding agent's prompt.
 *
 * Its own module because `studio-preamble.ts` is at the file-length cap and
 * because the two are read for different reasons: that file is the shared
 * "how to be a good coding agent here" arc, this one is "what you are building
 * is a web app, not a conversation". `studio-prompt.ts` composes them.
 */

/**
 * What a WORKFLOW project's coding agent is told, on top of the studio preamble.
 *
 * An addendum rather than a second preamble, and that is a deliberate trade.
 * Most of what the base preamble says is about being a good coding agent in this
 * environment — the tool loop, `test_agent`, debugging, secrets, the design
 * rules, the refusals — and none of it changes because the artifact is a web app
 * instead of a voice agent. Forking the whole thing would mean maintaining two
 * copies of 400 lines that must not drift, and the half that drifts silently is
 * the copy nobody is currently editing.
 *
 * So this block does two things, in the order that matters: it REPLACES the
 * target (what to build), and it names the sections above that no longer apply.
 * Naming them is the sharp tool the module doc warns about, used deliberately
 * here — a workflow project that gets told to write a greeting and a `voice`
 * produces an agent whose page cannot even open.
 *
 * It is inserted BETWEEN the preamble and the framework reference, so it keeps
 * the "preamble outranks the reference" property while also coming after — and
 * therefore overriding — the voice-shaped preamble text.
 *
 * **It carries no code examples and no workflow-body rules, deliberately.** The
 * reference concatenated straight after it is the scaffold guide, whose
 * "Durable workflows" and "Workflow apps" sections already hold both shapes
 * (`agent.ts` and `client.tsx`), the five replay rules, the blob upload/release
 * ordering and the HTTP API — and a second copy in the same prompt is one that
 * can disagree with the first, in the one place where the SDK's own guide is the
 * authority. What is left here is only what the guide cannot say: which of the
 * preamble's instructions this project overrides, and where to read the rest.
 */
export const WORKFLOW_PREAMBLE_ADDENDUM = `
## THIS PROJECT IS A WORKFLOW APP, NOT A VOICE AGENT

Everything above about being a good coding agent here still applies — the tool
loop, test_agent, debugging, secrets, the design guidelines, the refusals. What
changes is WHAT YOU ARE BUILDING, and it changes completely. Read this section
as overriding anything above it that assumes a voice agent.

You are building a **workflow app**: a static web page plus durable
server-side work. There is no conversation, no microphone, no turn-taking, and
no spoken reply anywhere in it.

### What overrides what

- **\`page: "static"\`** on \`agent()\` is what makes this a web app. It refuses
  the voice surfaces outright, so an app that omits it is serving a WebSocket
  nothing connects to. Always set it.
- **\`workflows\`, not \`tools\`.** A tool runs inside one turn and dies with the
  session; there is no turn here. A workflow is journaled and outlives
  everything. Declare no tools at all unless the app ALSO holds conversations.
- **No \`greeting\`, no \`voice\`, no \`systemPrompt\`, no stt/llm/tts/s2s
  providers.** Those configure a conversation this app does not have.
  (\`ctx.generate\` is still available INSIDE a workflow when the work itself
  needs a model.)
- **\`client.tsx\` mounts with \`page()\`, never \`client()\`** — \`client()\` builds
  a session, opens a microphone and connects a WebSocket, all of which fail
  here. Do NOT use useSession, Controls, ChatView, StartScreen, MessageList, or
  any other voice component. The design guidelines DO apply — this is still a
  real UI and should look like one.
- **Storage is required**, since the journal lives in the app's database, and a
  workflow project has it switched ON from the moment it is created — you do not
  need to ask for it. It is provisioned by the project's first deploy, so if a run
  reports it missing before anything has been deployed, that is the reason and it
  resolves itself; only tell the user to check Settings → Database if it persists
  after a deploy.

### Where the shapes are written down

Everything else about writing one is in the guide below, and it is the
authority — do not re-derive it from memory. **Durable workflows** has the
\`agent.ts\` shape, the replay rules (\`ctx.step\`, \`ctx.sleep\`, determinism,
at-least-once) and how bytes reach a run (\`api.upload\` → \`ctx.blob\` →
\`ctx.releaseBlob\`, in that order). **Workflow apps** has the \`client.tsx\`
shape and the HTTP API — the same routes the page uses are public, so a user can
drive the app from a script instead. Mention that when it is relevant; it is
often the reason someone wants a workflow.

### Read the worked example first

\`list_templates\` includes **transcription-desk**, which is exactly this shape:
a static upload page that chunks audio in the browser and a workflow that
transcribes each chunk. Use \`use_template\` to start from it whenever the request
is anything like it, rather than retyping the pattern.
`;
