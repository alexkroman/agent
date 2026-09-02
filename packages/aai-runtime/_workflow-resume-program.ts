// Copyright 2026 the AAI authors. MIT license.
/**
 * The GRAMMAR of a generated workflow body, and the compiler that runs one.
 *
 * A {@link Program} is a list of {@link Node}s; {@link runProgram} walks it
 * against a real `WorkflowCtx`, and {@link expectedOutput} says what the answer
 * must be WITHOUT the engine. Nothing here interrupts anything: the two crash
 * models are `_workflow-resume-harness.ts` (a killed worker) and
 * `_workflow-rebuild-harness.ts` (a rebuilt engine), and both are written
 * against this file. It was split out of the first of them at the seam that
 * separation names — a grammar two drivers share is not one driver's private
 * detail — and `workflow-resume-equivalence.test.ts` still imports these names
 * through that module, which re-exports them.
 *
 * ## What the grammar deliberately does NOT generate
 *
 * Four shapes whose non-determinism belongs to the AUTHOR rather than to the
 * engine, and which would therefore produce false findings. A wait inside a
 * FAN-OUT: a wait's key is `sleep!<label>#<n>`, and the OCCURRENCE half of that
 * is assigned by REACH ORDER — which two racing branches do not agree on across
 * walks. Naming the waits did not change this and could not: it made a wait's
 * key independent of how many OTHER waits were reached, where a fan-out's
 * problem is how many of the SAME one were reached first. It is precisely the
 * rule `mapConcurrent` states for steps ("the same sequence of step calls for
 * every item"), and it is why the grammar fans out steps and not waits. More
 * than one step per `mapConcurrent` CALLBACK, which that function's own doc
 * refuses. And a body that CATCHES: legitimate, and covered by
 * `workflow-replay.test.ts`, but a generated one would swallow the abort a
 * simulated crash is made of and turn it into a run failure.
 *
 * The fourth is a wait inside a STEP, which used to be generated as `nestedWait`
 * and is now a program the engine REFUSES — `workflow-replay-wait.ts` carries
 * the bugs it produced. Its own key argument is retired: a settled step's body
 * is not re-executed, so its wait stops being reached, and under positional keys
 * every later wait slid one place down the key space. Named keys close that; the
 * refusal is still owed for the duplicate step execution and for liveness. What
 * that node was the 10-out-of-10
 * regression for — a suspend RELEASING its attempt charge — is not covered any
 * more and does not need to be: the arm it defended is GONE. A suspension is no
 * longer a throw at all, so nothing unwinds through a step's attempt loop and
 * there is no charge for one to give back — see `workflow-replay-suspend.ts`.
 *
 * ## An orchestrating step body is not COUNTED work
 *
 * `nested` wraps other steps in an outer `ctx.step`, whose entry
 * is not written until its children's are — so a crash inside one re-runs the
 * outer body on resume. That is honest at-least-once behaviour of nesting rather
 * than a defect, so the outer body performs no counted work: the exactly-once
 * claim is about LEAF step bodies, each of which has its own journal row.
 */

import type { SleepOptions, StepOptions, WorkflowCtx } from "@alexkroman1/aai";
import { mapConcurrent } from "@alexkroman1/aai/step";
import { FatalError } from "@alexkroman1/aai/step-errors";

/** Long enough that no generated wait can elapse on its own. */
export const WAIT_MS = 60_000;

/** A step that settles on its own. `flaky` throws once, then succeeds. */
export type Leaf = {
  readonly t: "step" | "flaky";
  readonly name: string;
  readonly value: number;
};

/** How a `ctx.waitFor` is answered. `timeout` never suspends: its window is already shut. */
export type HookMode = "signal" | "timedSignal" | "timeout";

/** One statement of a generated body, run in order. */
export type Node =
  | Leaf
  | { readonly t: "boom"; readonly name: string }
  | { readonly t: "loop"; readonly name: string; readonly count: number }
  | { readonly t: "sleep"; readonly waitLabel: string }
  | { readonly t: "hook"; readonly token: string; readonly mode: HookMode }
  | { readonly t: "all"; readonly children: readonly Leaf[] }
  | { readonly t: "map"; readonly width: number; readonly children: readonly Leaf[] }
  | { readonly t: "nested"; readonly name: string; readonly children: readonly Leaf[] };

/** A whole generated body. */
export type Program = readonly Node[];

/** The bookkeeping a generated body reports through. */
export type Recorder = {
  /** Record an invocation of `name`'s body, and answer its global sequence number. */
  count(name: string): number;
  /** How many times `name`'s body has run so far, this invocation included. */
  runs(name: string): number;
  /** The end of an invocation, where a crash or a cancel is injected. */
  after(seq: number): Promise<void>;
};

/**
 * Give every step, token and wait a name derived from its POSITION.
 *
 * Unique by construction, which is deliberate: a fan-out's branches reach their
 * steps in whatever order the loop resumes them, so shared names would make the
 * `name#occurrence` key depend on scheduling. `loop` is the one node that reuses
 * a name, and it is strictly sequential — which is the case occurrences exist for.
 *
 * **A `sleep` gets one too, and it has to be per NODE rather than one shared
 * label.** A wait is keyed `sleep!<label>#<occurrence>`, so a single label for
 * every generated sleep collapses the whole program's waits back onto one
 * counter — positional keying under a new spelling, and the property would stop
 * exercising the thing it is generating waits to exercise. Two sleeps at two
 * positions are two labels, which is what a real body with two waits looks like.
 */
export function label(program: Program): Program {
  let n = 0;
  const next = () => `s${n++}`;
  const leaves = (children: readonly Leaf[]): Leaf[] =>
    children.map((child) => ({ ...child, name: next() }));
  return program.map((node): Node => {
    switch (node.t) {
      case "step":
      case "flaky":
      case "boom":
      case "loop":
        return { ...node, name: next() };
      case "sleep":
        return { ...node, waitLabel: `w${n++}` };
      case "hook":
        return { ...node, token: `tok${n++}` };
      case "all":
      case "map":
        return { ...node, children: leaves(node.children) };
      case "nested":
        return { ...node, name: next(), children: leaves(node.children) };
      default:
        return unreachable(node);
    }
  });
}

/**
 * A node the switches above do not handle.
 *
 * Every switch here is exhaustive over {@link Node}, which is what makes the
 * parameter `never` — so adding a node kind without teaching the walkers about
 * it is a compile error rather than a `default` that quietly does nothing.
 */
function unreachable(node: never): never {
  throw new Error(`unhandled generated node: ${JSON.stringify(node)}`);
}

/** Does this program reach a step that fails the run? */
export function fails(program: Program): boolean {
  return program.some((node) => node.t === "boom");
}

/** What the run's output must be, computed WITHOUT the engine. */
export function expectedOutput(program: Program): unknown[] {
  return program.map(nodeValue);
}

function nodeValue(node: Node): unknown {
  switch (node.t) {
    case "step":
    case "flaky":
      return node.value;
    case "boom":
      return undefined;
    case "loop":
      return Array.from({ length: node.count }, (_unused, i) => i);
    case "sleep":
      return null;
    case "hook":
      return node.mode === "timeout" ? undefined : { ok: node.token };
    case "all":
    case "map":
    case "nested":
      return node.children.map(nodeValue);
    default:
      return unreachable(node);
  }
}

/** Every hook token the program declares, in reach order. */
export function tokensOf(program: Program): { token: string; mode: HookMode }[] {
  return program.flatMap((node) =>
    node.t === "hook" ? [{ token: node.token, mode: node.mode }] : [],
  );
}

/**
 * `ctx`, with `ctx.step` and `ctx.sleep` narrowed to accept a name this harness
 * COMPUTES.
 *
 * Both refuse a name widened to `string` — the call-site layer of the identity
 * rule, `Literal<Name>` resolving to `never` — and every name here comes from
 * {@link label}, a node's POSITION in a generated program: unbounded, so not a
 * union of literals. This is the escape that constraint is designed to allow, in
 * the shape `workflow-ctx.ts` names — one typed alias where {@link runProgram}
 * receives the context, not a cast per site. No `as`, so `check:hatches` is owed
 * nothing.
 *
 * `sleep` joined it when waits stopped being keyed positionally: a generated
 * wait needs a label, and a label per NODE is the only kind that keeps the
 * program's waits on separate counters.
 */
type GeneratedCtx = Omit<WorkflowCtx, "step" | "sleep"> & {
  step<T>(name: string, fn: () => Promise<T> | T, options?: StepOptions): Promise<T>;
  sleep(label: string, until: number | Date, options?: SleepOptions): Promise<void>;
};

/** One leaf step: the body, wrapped so its invocation is counted. */
function leafBody(leaf: Leaf, rec: Recorder): () => Promise<number> {
  return async () => {
    const seq = rec.count(leaf.name);
    try {
      if (leaf.t === "flaky" && rec.runs(leaf.name) === 1) {
        // A plain Error, so `retryDelay` is 0 and the retry costs no wall clock.
        throw new Error(`flaky ${leaf.name}`);
      }
      return leaf.value;
    } finally {
      await rec.after(seq);
    }
  };
}

function runLeaf(leaf: Leaf, ctx: GeneratedCtx, rec: Recorder): Promise<number> {
  return ctx.step(leaf.name, leafBody(leaf, rec));
}

async function runNode(node: Node, ctx: GeneratedCtx, rec: Recorder): Promise<unknown> {
  switch (node.t) {
    case "step":
    case "flaky":
      return runLeaf(node, ctx, rec);
    case "boom":
      return ctx.step(node.name, async () => {
        const seq = rec.count(node.name);
        try {
          throw new FatalError(`boom ${node.name}`);
        } finally {
          await rec.after(seq);
        }
      });
    case "loop": {
      const out: number[] = [];
      for (let i = 0; i < node.count; i++) {
        out.push(
          await ctx.step(node.name, async () => {
            const seq = rec.count(node.name);
            try {
              return i;
            } finally {
              await rec.after(seq);
            }
          }),
        );
      }
      return out;
    }
    case "sleep":
      await ctx.sleep(node.waitLabel, WAIT_MS);
      return null;
    case "hook":
      if (node.mode === "signal") return ctx.waitFor(node.token);
      // A deadline already in the past closes the window without suspending,
      // which is the other branch of `waitFor` and the one `closeHook` decides.
      return ctx.waitFor(node.token, { timeoutMs: node.mode === "timeout" ? -1 : WAIT_MS });
    case "all":
      return Promise.all(node.children.map((child) => runLeaf(child, ctx, rec)));
    case "map":
      return mapConcurrent(node.children, node.width, (child) => runLeaf(child, ctx, rec));
    case "nested":
      // The outer body does no counted work — see this module's doc.
      return ctx.step(node.name, async () => {
        const inner: unknown[] = [];
        for (const child of node.children) inner.push(await runLeaf(child, ctx, rec));
        return inner;
      });
    default:
      return unreachable(node);
  }
}

export async function runProgram(
  program: Program,
  raw: WorkflowCtx,
  rec: Recorder,
): Promise<unknown[]> {
  const ctx: GeneratedCtx = raw; // The one narrowing — see {@link GeneratedCtx}.
  const out: unknown[] = [];
  for (const node of program) out.push(await runNode(node, ctx, rec));
  return out;
}
