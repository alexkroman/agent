// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `testing`.
 *
 * Driving an agent's own machinery from a spec, with the real engine in the path
 * and one substitution each.
 *
 * A DURABLE workflow run over the memory journal, with the driver supplying what
 * a deployment's queue supplies: one delivery at a time, a suspension recorded
 * rather than waited out, a hook answered, a worker killed, and a fresh engine
 * over the same journal.
 *
 * And a TEXT agent turn over a scripted `LanguageModel`, where the provider
 * socket is the only fake: the real `createTextAgent`, the real tool executor
 * and the real `ctx`. Its own capability rather than `text`'s, for the same
 * reason the workflow half is not `workflow`'s — the promise being versioned is
 * what a SPEC may rely on, which moves independently of the surface it drives.
 *
 * Its own capability rather than part of `eval`, although both are surfaces a
 * TEST imports, because the two make different promises. `eval` drives an agent
 * from text over an engine that is explicitly NOT durable — no journal, no
 * replay, no retry — and its own doc forbids reporting a case there as covering
 * any of the three. This is the opposite claim, and folding them together would
 * mean one epoch for two contracts that move for unrelated reasons.
 *
 * ## This report carries `TextAgentOptions`, and that is deliberate
 *
 * `RunTextAgentOptions` is `TextAgentOptions` minus the two fields the harness
 * supplies — derived by subtraction so a capability added to a text agent is
 * reachable from a spec the day it lands, rather than silently absent. The cost
 * is that the type is INLINED into this rollup, so a signature change on
 * `TextAgentOptions` moves this capability's hash as well as `text`'s and both
 * want classifying. It is the honest coupling: a change to what a text agent
 * accepts really is a change to what this harness accepts. Restating the fields by hand would hide it and re-open the omission.
 *
 * The drivers are on ONE subpath, and deliberately not a `/testing/vitest`
 * sibling: none of them installs a process-global or owns a lifetime a runner
 * has to unwind, which is this repo's rule for what may stay off a
 * runner-flavoured subpath. The workflow driver injects its own dispatcher, so
 * no timer is ever armed, and the text harness builds one agent per call and
 * hands it to nobody. The one name here that DOES install — `installStubFfmpeg`,
 * a scripted child in place of the ffmpeg binary — is on `/testing/vitest` for
 * exactly that reason, and belongs to this capability rather than `eval`'s
 * because what it serves is a step spec: the promise is "a step that spawns
 * ffmpeg runs end to end in the unit tier", which moves with the drivers.
 *
 * Re-exported from `@alexkroman1/aai-runtime/testing` (the drivers) and
 * `@alexkroman1/aai-runtime/testing/vitest` (the installer). This file is not shipped
 * and nothing imports it — it exists so `pnpm check:api-contracts` can extract a
 * report for this capability alone, hash it, and hold it to a committed epoch.
 * See `scripts/api-contracts.mjs`.
 */

// ## No JOURNAL shapes
//
// `RunWorkflowOptions.journal` takes the opaque `WorkflowJournal` (owned by
// `workflow`), not the sixteen-method store, which moved with every engine
// change and dragged this capability with it. What a spec reads off a run's
// journal is the handle's own `steps`, `reads` and `waits`.
export {
  DEFAULT_MAX_DELIVERIES,
  type RunTextAgentOptions,
  type RunWorkflowOptions,
  runTextAgent,
  runWorkflow,
  type ScriptedTextStep,
  type ScriptedToolCall,
  scriptedTextModel,
  type TextAgentTestRun,
  type TextAgentTestToolCall,
  type WorkflowTestHandle,
  type WorkflowTestRead,
  type WorkflowTestRun,
  type WorkflowTestStep,
  type WorkflowTestWait,
} from "../../testing-barrel.ts";
export {
  installStubFfmpeg,
  type StubFfmpeg,
  type StubFfmpegCall,
  type StubFfmpegReply,
  type StubFfmpegScript,
} from "../../testing-vitest-barrel.ts";
