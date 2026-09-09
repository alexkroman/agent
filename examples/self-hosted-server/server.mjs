// Deploy an agent template to your own Node process — no managed platform, no
// `aai` CLI.
//
// `agent.ts` next to this file is the `quickstart-agent` template verbatim, untouched.
// This file is the deployment.
//
// The agent's tools are the files in `tools/` next to this one, and they run
// IN THIS PROCESS on your credentials — the opposite arrangement from
// `examples/host-server`, where callers bring their own agent and execute
// their own tools.
//
// Run it:
//
//   npm install
//   export ASSEMBLYAI_API_KEY=…
//   npm start
//
// then open http://127.0.0.1:3000.
//
// Two more variables are optional and only matter once state or a durable
// workflow does: DATABASE_URL (below) and PUBLIC_URL (below that).

import { createAgentServer, withToolsDir } from "@alexkroman1/aai-runtime";
import { defaultClientDir } from "@alexkroman1/aai-ui/client-dir";
// Node 24 strips the types natively, so the template's `.ts` is imported as-is
// — no build step, and no second copy of the agent in JavaScript that could
// drift from the one you deploy.
import agent from "./agent.ts";

const apiKey = process.env.ASSEMBLYAI_API_KEY;
if (!apiKey) {
  console.error("Set ASSEMBLYAI_API_KEY (the default pipeline is all-AssemblyAI).");
  process.exit(1);
}

// Every file in `tools/` is a tool, named by its own file name — `roll_die.ts`
// is `roll_die` — and this line is the whole registration. Adding a tool is
// adding a file; nothing here or in `agent.ts` learns its name. On the managed
// platform the CLI's bundler does this enumeration at build time, which is why
// `agent.ts` takes no `tools` field on any path.
const served = await withToolsDir(agent, new URL("./tools/", import.meta.url));

// `env` is what tool code sees as `ctx.env`, and where provider credentials are
// resolved from. On the platform this comes from `aai secret put`; here it is
// yours to assemble — from a vault, a mounted file, whatever you already use.
// Nothing falls back to the host's process.env on its own.
//
// `DATABASE_URL` is the one entry that is more than a credential: set it and
// session state and durable workflow runs go to that database instead of this
// process's memory, which is what makes a restart — or a second replica behind
// a load balancer — keep a conversation. The TABLES come with whoever owns the
// database, and a self-hosted deployment has no migration step to hang them
// off, so `createAgentServer` creates its own at boot, before it binds.
// (`ensureSessionStateSchema` and `ensureWorkflowJournalSchema` are still
// exported for an operator who would rather run that DDL out of band.)
const server = createAgentServer({
  agent: served,
  env: {
    ASSEMBLYAI_API_KEY: apiKey,
    // Unset reads as an empty string, which is treated as no database at all —
    // so this one line covers both deployments.
    DATABASE_URL: process.env.DATABASE_URL ?? "",
  },
  // Where this deployment is reachable from OUTSIDE, which behind a proxy is
  // not the socket it binds — so it is never derived from PORT. Set it whenever
  // a durable workflow has to hand a URL to somebody else:
  // `ctx.workflows.publicWebhookUrl()` is the only reader, and unconfigured it
  // THROWS naming this option rather than minting a `http://127.0.0.1:3000`
  // callback a payment provider will dial days later and fail.
  publicUrl: process.env.PUBLIC_URL,
  // The prebuilt browser UI that `aai dev` serves, shipped inside aai-ui.
  clientDir: defaultClientDir(),
});

// listen() binds loopback by default — the server has no request auth of its
// own. Behind your own reverse proxy / auth, pass "0.0.0.0" to expose it.
await server.listen(Number(process.env.PORT ?? 3000));
console.log(`${agent.name} listening on http://127.0.0.1:${server.port}`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  // close() shuts the runtime down too — no separate runtime.shutdown().
  process.once(signal, async () => {
    await server.close();
    process.exit(0);
  });
}
