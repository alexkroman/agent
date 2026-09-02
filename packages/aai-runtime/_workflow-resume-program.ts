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
 * FAN-OUT: sleeps and hooks are keyed positionally (`sleep!N` by reach order),
 * so two branches racing to reach one key the same wait differently on two
 * walks — `ctx.step` is keyed by name, which is why steps may fan out and waits
 * may not. More than one step per `mapConcurrent` CALLBACK, which that
 * function's own doc refuses. And a body that CATCHES: legitimate, and covered
 * by `workflow-replay.test.ts`, but a generated one would swallow the abort a
 * simulated crash is made of and turn it into a run failure.
 *
 * The fourth is a wait inside a STEP, which used to be generated as `nestedWait`
 * and is now a program the engine REFUSES — `workflow-replay-wait.ts` carries
 * both bugs it produced. It is the same positional-key argument as the fan-out
 * exclusion above, arriving by the other door: a settled step's body is not
 * re-executed, so its wait stops being reached and every later wait in the run
 * slides one place down the key space. What that node was the 10-out-of-10
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

import type { StepOptions, WorkflowCtx } from "@alexkroman1/aai";
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
  | { readonly t: "sleep" }
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
 * Give every step and token a name derived from its POSITION.
 *
 * Unique by construction, which is deliberate: a fan-out's branches reach their
 * steps in whatever order the loop resumes them, so shared names would make the
 * `name#occurrence` key depend on scheduling. `loop` is the one node that reuses
 * a name, and it is strictly sequential — which is the case occurrences exist for.
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
        return node;
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
 * `ctx`, with `ctx.step` narrowed to accept a name this harness COMPUTES.
 *
 * `WorkflowCtx.step` refuses a name widened to `string` — the call-site layer of
 * the step-identity rule, `Literal<Name>` resolving to `never` — and every name
 * here comes from {@link label}, a node's POSITION in a generated program:
 * unbounded, so not a union of literals. This is the escape that constraint is
 * designed to allow, in the shape `workflow-ctx.ts` names — one typed alias
 * where {@link runProgram} receives the context, not a cast per site. No `as`,
 * so `check:hatches` is owed nothing.
 */
type GeneratedCtx = Omit<WorkflowCtx, "step"> & {
  step<T>(name: string, fn: () => Promise<T> | T, options?: StepOptions): Promise<T>;
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
      await ctx.sleep(WAIT_MS);
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
