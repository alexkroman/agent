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
 * target (what to build, what the files look like), and it names the sections
 * above that no longer apply. Naming them is the sharp tool the module doc warns
 * about, used deliberately here — a workflow project that gets told to write a
 * greeting and a `voice` produces an agent whose page cannot even open.
 *
 * It is inserted BETWEEN the preamble and the framework reference, so it keeps
 * the "preamble outranks the reference" property while also coming after — and
 * therefore overriding — the voice-shaped preamble text.
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

### What agent.ts looks like

\`\`\`ts
import { agent, workflow } from "@alexkroman1/aai";
import { z } from "zod";

const process = workflow({
  description: "What this run does",
  input: z.object({ url: z.string() }),
  async run({ url }, ctx) {
    const fetched = await ctx.step("fetch", async () => {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(\`fetch failed: \${resp.status}\`);
      return await resp.text();
    });
    return { chars: fetched.length };
  },
});

export default agent({
  name: "My App",
  page: "static",
  workflows: { process },
});
\`\`\`

Three things are load-bearing:

- **\`page: "static"\`** is what makes this a web app. It refuses the voice
  surfaces outright, so an app that omits it is serving a WebSocket nothing
  connects to. Always set it.
- **\`workflows\`, not \`tools\`.** A tool runs inside one turn and dies with the
  session; there is no turn here. A workflow is journaled and outlives
  everything. Declare no tools at all unless the app ALSO holds conversations.
- **No \`greeting\`, no \`voice\`, no \`systemPrompt\`, no stt/llm/tts/s2s
  providers.** Those configure a conversation this app does not have. (\`ctx.generate\`
  is still available INSIDE a workflow when the work itself needs a model.)

### What client.tsx looks like

The page mounts with \`page()\`, never \`client()\` — \`client()\` builds a session,
opens a microphone, and connects a WebSocket, all of which fail here. It talks
to the workflow HTTP API instead:

\`\`\`tsx
import "@alexkroman1/aai-ui/styles.css";
import { createWorkflowApi, page, useWorkflowRun } from "@alexkroman1/aai-ui";
import { useState } from "react";

const api = createWorkflowApi();

function App() {
  const [runId, setRunId] = useState<string>();
  const { run } = useWorkflowRun(runId, { api });
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
      <button
        type="button"
        onClick={() => void api.start("process", { url: "https://example.com" }).then(setRunId)}
      >
        Start
      </button>
      {run && <p>{run.status} — {run.stepsCompleted} step(s)</p>}
    </main>
  );
}

page({ name: "My App", component: App });
\`\`\`

Do NOT use useSession, Controls, ChatView, StartScreen, MessageList, or any
other voice component. The design guidelines above DO apply — this is still a
real UI and should look like one.

### Writing the workflow body

- **Every unit of work is a \`ctx.step(name, fn)\`.** A completed step is
  journaled and never re-runs, so a run that dies resumes from the last one. Work
  outside a step is redone on every resume.
- **Steps are at-least-once.** A crash between \`fn\` returning and the journal
  write re-runs it, so an external side effect wants an idempotency key.
- **The SEQUENCE of steps must be deterministic.** Branch on values that came
  out of a step or the input — never on \`Date.now()\` or \`Math.random()\` read in
  the workflow body.
- **\`await ctx.sleep(ms)\` is durable** — it releases the run instead of holding
  a process open, and the run resumes when due. Use it for polling loops and
  waits, never \`setTimeout\`.
- **Bytes never go in the run input or a step's return value.** Both are
  journaled and re-read on every replay. A page uploads with \`api.upload(bytes)\`
  and passes the returned id; the run reads it with \`await ctx.blob(id)\` inside
  the step that needs it and calls \`ctx.releaseBlob(id)\` when done.
- **Storage is required.** The journal lives in the app's database, so tell the
  user to switch the Database on in Settings if runs report it missing.

### The API is also the integration

The same routes the page uses are a public HTTP API, so a user can drive the app
from a script instead of the page — \`POST /workflows/runs\` with
\`{ "workflow": "<name>", "input": … }\`, then \`GET /workflows/runs/<id>\`. Mention
this when it is relevant; it is often the reason someone wants a workflow.

### Read the worked example first

\`list_templates\` includes **transcription-desk**, which is exactly this shape:
a static upload page that chunks audio in the browser and a workflow that
transcribes each chunk. Use \`use_template\` to start from it whenever the request
is anything like it, rather than retyping the pattern.
`;
