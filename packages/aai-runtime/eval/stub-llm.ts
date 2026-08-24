// Copyright 2026 the AAI authors. MIT license.
/**
 * The SCRIPTED model an eval falls back to when there is no key.
 *
 * The problem it solves is that the two honest states of an eval suite — "a
 * live model measured the agent" and "no key, so nothing ran" — leave the second
 * one indistinguishable from a suite that is BROKEN. A skipped eval still
 * compiles; it does not tell you that `agent.ts` still boots, that its tools
 * still resolve, that the session still reaches a reply, or that the eval file
 * itself still drives anything. Every one of those breaks silently and is
 * exactly what a pipeline can check for free.
 *
 * So there is a third state: the whole harness runs — the real runtime, the real
 * pipeline transport, the real tool executor, the real session event stream —
 * with the MODEL scripted. That is a wiring check, and this module's whole job
 * is to make sure nobody mistakes it for a behaviour measurement:
 * `describeEval` announces the mode it chose, in one line, every run.
 *
 * It registers through `registerLlmKind` for the same reason the fake speech
 * stages register through their own seams — a stub that resolves through the
 * registry resolves exactly like a real provider, credential and all, so the
 * code under it takes the path production takes.
 *
 * @module
 */

import type { LlmProvider } from "@alexkroman1/aai/llm";
import { createFakeLanguageModel } from "../_fake-llm.ts";
import { registerLlmKind } from "../providers/resolve.ts";

/** The env var the stub model resolves its (unused) credential from. */
export const STUB_LLM_API_KEY_ENV = "AAI_EVAL_STUB_LLM_KEY";

/** A registered stub model, and what to hand a session. */
export type StubLlm = {
  /** Pass as {@link EvalSessionOptions.llm}. */
  readonly llm: LlmProvider;
  /** Merge into the session's provider env. */
  readonly env: Record<string, string>;
  /** Unregister the kind. Every install owes one. */
  release(): void;
};

let installs = 0;

/**
 * Register a model that answers with `replies`, one per model call, repeating
 * the last for as long as it is asked.
 *
 * Repeating rather than falling silent is deliberate: a caller scripting one
 * reply cannot know how many calls a turn will make (a tool loop makes several),
 * and an empty answer reads as an agent that stopped talking — a failure that
 * looks like the agent's and is the harness's.
 *
 * The kind is UNIQUE per install, because the registry is process-global and two
 * concurrent eval sessions must not serve each other's replies.
 */
export function installStubLlm(replies: string | readonly string[]): StubLlm {
  installs += 1;
  const kind = `aai-eval-stub-llm-${installs}`;
  const script = (typeof replies === "string" ? [replies] : replies).map((text) => [
    { type: "text" as const, text },
  ]);
  const release = registerLlmKind(kind, {
    envVar: STUB_LLM_API_KEY_ENV,
    label: "Eval stub",
    create: () => createFakeLanguageModel({ steps: script, repeatLast: true }),
  });
  return {
    llm: { kind, options: {} },
    env: { [STUB_LLM_API_KEY_ENV]: "eval-stub-llm" },
    release,
  };
}
