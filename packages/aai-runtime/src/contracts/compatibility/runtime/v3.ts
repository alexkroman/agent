// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-runtime:runtime` epoch 3.
 *
 * A host BUILDING a runtime and starting one session on it — which is what this
 * capability is for, and the shape an embedder copies when it already owns its
 * own HTTP server and wants only the session core. Written the way it was
 * authored at epoch 3, and it must keep compiling for as long as that epoch is
 * advertised as supported.
 *
 * ## What moved, and why epoch 3 survives it
 *
 * Epoch 4 added an optional `deliverWorkflow` to `AgentRuntime` and widened
 * `SessionRuntime`'s `Pick` to carry it: the replay engine's queue-delivery hook,
 * which a deployed guest's platform queue calls to re-walk a run whose sandbox
 * had already exited.
 *
 * Adding an OPTIONAL member to a type a caller RECEIVES is not breaking, which is
 * what makes this a retain: everything below still compiles, and a host that
 * never reads `deliverWorkflow` gets the same runtime it always had.
 *
 * **The direction that WOULD break is an IMPLEMENTOR** — a host supplying its own
 * object as a `SessionRuntime` — and it does not break even there, the field
 * being optional. That is the whole reason this is a retain and not a drop: a
 * `Pick` that gained a REQUIRED member would have broken every hand-written
 * facade, `decliningRuntime`'s callers included.
 *
 * Editing this file to make a future error go away defeats the mechanism: the
 * error IS the finding, and it means epoch 3 has to be dropped with a reason.
 */

import { agent } from "@alexkroman1/aai";
import {
  type AgentRuntime,
  createRuntime,
  decliningRuntime,
  type RuntimeOptions,
  type SessionRuntime,
  type SessionStartOptions,
  type SessionWebSocket,
} from "../../../runtime-barrel.ts";

/**
 * ── EDIT: the agent this host runs. ──────────────────────────────────────
 *
 * No `tools` key, and the type is what says so: a tool is declared by its FILE
 * (`tools/<the name the model calls>.ts`, `export default tool({ … })`) and is
 * registered by existing. A host with no bundler in its path reaches that
 * registry through `withToolsDir(definition, dir)`.
 */
const definition = agent({
  name: "order-desk",
  systemPrompt: "You take pizza orders. Confirm the address before finishing.",
  greeting: "Order desk, what can I get you?",
});

/**
 * ── EDIT: where the credentials come from. ───────────────────────────────
 *
 * `env` and `providerEnv` are both required and they are different questions.
 * `env` is what `ctx.env` gives a tool — the agent's own declared keys. A
 * provider credential goes in `providerEnv`, so a container can pass one without
 * it becoming readable by tool code.
 */
const options: RuntimeOptions = {
  agent: definition,
  env: {},
  providerEnv: { ASSEMBLYAI_API_KEY: process.env.ASSEMBLYAI_API_KEY ?? "" },
};

/**
 * Build it once per process.
 *
 * A runtime owns the session map, the provider clients and — for an agent that
 * declares workflows — one workflow client with one correlation-key index. Two
 * runtimes over one agent index those keys separately, so a `find` from a tool
 * misses a run a page can see.
 */
const runtime: AgentRuntime = createRuntime(options);

/**
 * Start one session on a socket this host already accepted.
 *
 * `SessionWebSocket` is the narrow surface the runtime needs — send, close, and
 * the two listeners — rather than any particular `ws` type, which is what lets a
 * host bring its own implementation. Taking it as that type rather than as
 * `unknown` plus a cast is the point: a cast here would compile against a shape
 * that has since moved, which is precisely what a frozen example exists to catch.
 */
export function serve(ws: SessionWebSocket, opts: SessionStartOptions = {}): void {
  runtime.startSession(ws, opts);
}

/**
 * The facade to hand a server when this host is NOT ready to take sessions.
 *
 * A boot that failed halfway is the case worth having: turning every session
 * away with a reason is what stops a client reconnecting against a socket that
 * will never answer.
 */
export function unavailable(reason: string): SessionRuntime {
  return decliningRuntime(reason);
}

/** ── EDIT: the shutdown your process already has. ───────────────────────── */
export async function stop(): Promise<void> {
  await runtime.shutdown();
}
