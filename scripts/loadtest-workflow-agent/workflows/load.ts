// The three shapes a durable run comes in, each isolated so a number says which
// one moved.
//
// Copied over a scaffolded project by `scripts/loadtest-boot.sh workflow`, which
// is why this lives under `scripts/` rather than in a template: it is bench
// scaffolding, and a starter that measures itself is not a starter.
//
// **These bodies are only DURABLE after the WDK builder has transformed them**,
// and the builder transforms exactly the files under a project's `workflows/`
// directory. So this agent is served by `aai dev` (or `npm start`), never by the
// single-process host the stub VOICE agent uses — there a `"use workflow"` body
// runs inline as an ordinary async function, with no journal to measure.
//
// Nothing here reaches a vendor. That is the point: a step's cost is the
// journal, the queue and the resume, and a provider's latency buried in the same
// number makes all three unreadable.
import { mapConcurrent, stepFetch } from "@alexkroman1/aai/step";
import { stepFetchOk } from "@alexkroman1/aai/step-errors";

/** One journaled step whose work is a fixed, tiny amount of CPU. */
async function tick(index: number, spin: number) {
  "use step";

  // A real number rather than nothing, so a step is never optimized into a
  // no-op — and small, because what is being measured is the round trip
  // AROUND the step, not the body.
  let acc = index;
  for (let i = 0; i < spin; i++) acc = (acc * 31 + i) % 1_000_003;
  return { index, acc };
}

/**
 * N steps in a straight line — the journal write and the claim, N times.
 *
 * The one measurement nothing else here gives: a run's cost per step with no
 * concurrency, no I/O and no suspension in it. Everything else is read against
 * this.
 */
export async function chainFlow(input: { steps: number; spin?: number }) {
  "use workflow";

  const spin = input.spin ?? 1000;
  let last = 0;
  for (let i = 0; i < input.steps; i++) {
    const result = await tick(i, spin);
    last = result.acc;
  }
  return { steps: input.steps, last };
}

/**
 * One HTTP round trip from inside a step.
 *
 * `classify` is the whole difference between two measurements, which is why it
 * is a flag rather than two step functions. Unclassified, a refusal is just a
 * status this step RETURNS, so a `--fail-rate` run measures throughput with the
 * far side's failures in it. Classified, `stepFetchOk` turns a 503 into the
 * DevKit's `RetryableError` carrying the far side's own `retry-after`, so the
 * same run measures the RETRY path — a `--retry-after=1` on a quarter of the
 * items adds a second to each of them, and that is the number worth having.
 *
 * Both are real shapes. A template should classify (the scaffold guide's rule);
 * a harness wants to be able to see the difference.
 */
async function fetchOne(url: string, index: number, classify: boolean) {
  "use step";

  const target = `${url}?i=${index}`;
  // A deadline of its own either way: a hung request inside a step is a run that
  // never finishes rather than one that retries.
  const init = { signal: AbortSignal.timeout(30_000) };
  const res = classify ? await stepFetchOk(target, init) : await stepFetch(target, init);
  const body = await res.text();
  return { index, status: res.status, bytes: body.length };
}

/**
 * `items` HTTP calls at `width` concurrency — the fan-out `mapConcurrent`
 * exists for, and the shape every transcribing template has.
 *
 * The window is the interesting variable: the primitive's contract is that the
 * SEQUENCE of items whose calls are issued is a pure function of the list, so a
 * replay hands the Nth journal entry to the Nth call however they settle. A
 * shuffled stub delay is what puts that under pressure.
 */
export async function fanoutFlow(input: {
  url: string;
  items: number;
  width?: number;
  classify?: boolean;
}) {
  "use workflow";

  const indices = Array.from({ length: input.items }, (_, i) => i);
  const classify = input.classify === true;
  const results = await mapConcurrent(indices, input.width ?? 8, (index) =>
    fetchOne(input.url, index, classify),
  );
  const ok = results.filter((one) => one.status >= 200 && one.status < 300).length;
  return { items: input.items, ok, bytes: results.reduce((sum, one) => sum + one.bytes, 0) };
}

/**
 * A step, a durable SLEEP, then a step — the suspend and the resume.
 *
 * The only one of the three that leaves the process: the run is written down and
 * nothing is resident until it comes due, so what this measures is how late a
 * resume is against the sleep it asked for. A `sleep` shorter than the queue's
 * own poll interval reports that interval, which is the number worth knowing.
 */
export async function napFlow(input: { ms: number }) {
  "use workflow";

  // Imported HERE rather than at module scope: `sleep` is the DevKit's, and a
  // module-scope import that a surviving top-level binding named would ride
  // into the step bundle. Nothing outside this body names it.
  const { sleep } = await import("workflow");
  const before = await tick(0, 100);
  await sleep(`${Math.max(1, Math.round(input.ms))} milliseconds`);
  const after = await tick(1, 100);
  return { sleptMs: input.ms, before: before.acc, after: after.acc };
}
