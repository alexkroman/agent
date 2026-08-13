// Copyright 2026 the AAI authors. MIT license.
/**
 * The durable half of the transcription desk: a run that PARKS ON A WEBHOOK and
 * then fans out over what the webhook delivered.
 *
 * Read `research-desk/workflows/research.ts` first. It states the two rules every
 * directive body obeys — replayed from the top, so no live handles and no
 * undurable decisions; step arguments and return values are serialized, so pass
 * an id and not a payload — and both hold here unchanged. This file adds the two
 * things that only show up once a workflow talks to the outside world and stops
 * being a straight line.
 *
 * ## 1. The shape of a real asynchronous API: submit, park, get called back
 *
 * A transcription service does not answer in the request. It takes a job and a
 * callback URL, returns an id, and calls you back minutes later. That is
 * `createWebhook()`: the run suspends at `await hook`, the container it was
 * running in is free to go away, and the delivery is what brings it back — which
 * is the entire argument for a durable workflow over a tool call.
 *
 * Three things about that are easy to get wrong, and all three are load-bearing
 * below:
 *
 * - **`createWebhook()` does not register the token; suspending does.** So the
 *   URL is claimed with `await hook.getConflict()` BEFORE it is handed out. A
 *   provider that calls back fast — and the stub here calls back inside the
 *   submit step, which is as fast as it gets — must not arrive at a token
 *   nothing is listening on yet.
 * - **The token is the only authorization on that URL.** It is a public endpoint
 *   (the DevKit says so in as many words), so a delivery is checked against the
 *   job id this run actually submitted rather than trusted for having reached
 *   the right token.
 * - **`hook.url` names the GUEST'S OWN origin**, so it is dialable from inside
 *   this container and nowhere else. A real provider gets a URL composed from
 *   `hook.token` and the agent's public origin —
 *   `https://<your-agent>/.well-known/workflow/v1/webhook/<token>` — which the
 *   platform proxies to whichever sandbox is serving the agent when the delivery
 *   lands, booting one if none is. That indirection is the point: a run that
 *   sleeps for a week outlives every sandbox that ever served it, and a tunnel
 *   URL does not.
 *
 * ## 2. A fan-out whose width comes from the delivery
 *
 * The transcript arrives as one blob and is post-processed segment by segment —
 * one step each, so a run that dies on segment 27 resumes having replayed 1-26
 * from the journal for free. The width is not knowable when the run starts; it
 * comes from the webhook payload, which is journaled, and that is what makes it
 * legal. (Anything the BODY computes for itself must be deterministic — the
 * ordinary rule, one level up.)
 *
 * The width is bounded by `mapInBatches`, and the bound is not a detail: the
 * Workflow DevKit correlates a journal entry to a step call **by the order the
 * call was issued in**, so a work-stealing pool — which issues its next call
 * only when a previous one settles — puts the calls in a different order on a
 * replay than it did on the first execution. That primitive is sequential
 * batches of `Promise.all` for exactly that reason; its module doc carries the
 * argument, and using it is how a template avoids restating it as a loop.
 */

import { mapInBatches } from "@alexkroman1/aai/utils";
import { createWebhook, FatalError, getWritable } from "workflow";

/**
 * Write one progress line to the run's own stream.
 *
 * The only way a run can say anything before it finishes: a snapshot carries a
 * status and, once terminal, an output, so without this a twelve-segment
 * recording reads as `running` for the whole fan-out. `client.tsx` reads it back
 * with `useWorkflowProgress`.
 *
 * Two properties worth copying. It is called from STEPS and never from the body,
 * the same rule as `ctx.db`: the body replays from the top on every resume, so a
 * line written there is re-emitted on each one. And it is BEST-EFFORT — a run
 * must not fail because its narration could not be written, which is also what
 * keeps the steps below callable from this template's own spec, where there is no
 * run and `getWritable()` throws by design.
 */
async function report(line: string): Promise<void> {
  try {
    const writer = getWritable<string>().getWriter();
    try {
      await writer.write(line);
    } finally {
      // Released rather than closed: later steps write to the same stream, and a
      // closed stream cannot be reopened.
      writer.releaseLock();
    }
  } catch {
    // No run in scope, or the stream is already gone. Neither is worth a failure.
  }
}

/**
 * Segments post-processed at once — see the module doc's second half.
 *
 * Bounded because the far side of a real call is a rate limit: a whole
 * transcript issued at once collects 429s, and a rate-limited segment fails its
 * step.
 */
const SEGMENT_CONCURRENCY = 4;

/** Words per segment. Stands in for a real per-request cap on a text API. */
const SEGMENT_WORDS = 40;

/** What the page uploads — a DESCRIPTION of a file, never its bytes. */
export type Upload = {
  name: string;
  /** MIME type the browser reported. */
  type: string;
  /** Size in bytes. */
  size: number;
};

/** What the provider's callback delivers. */
export type TranscriptionCallback = {
  jobId: string;
  transcript: string;
};

/**
 * Transcribe an uploaded recording and file the result.
 *
 * The input is what `POST workflows/transcribe/runs` carries — see `agent.ts`
 * for the schema it is validated against before a run exists.
 */
export async function transcribeFlow(input: {
  upload: Upload;
  requestedBy: string;
  redact: boolean;
}) {
  "use workflow";

  // `using`, so the token is released as soon as this run leaves the block
  // rather than being held until the run record ages out.
  using hook = createWebhook();

  // Claim the token BEFORE the URL is handed to anyone. See the module doc:
  // `createWebhook()` alone registers nothing, and this is the documented way to
  // suspend for exactly that. Its return value identifies a run already holding
  // the token, which cannot happen here — this hook has a generated one — so the
  // conflict branch a shared token would need is deliberately absent.
  await hook.getConflict();

  const jobId = await submitTranscriptionJob(input.upload, hook.url);

  // The suspension. Everything above is journaled; this run may resume in a
  // different container, days later, with the delivery as its only input.
  const request = await hook;
  const delivered = (await request.json()) as TranscriptionCallback;

  // The token is the endpoint's only authorization, so the payload is checked
  // against the job THIS run submitted. `FatalError` skips the retries: a
  // delivery for another job will not become the right one on a second attempt.
  if (delivered.jobId !== jobId) {
    throw new FatalError(`Callback for job "${delivered.jobId}", expected "${jobId}"`);
  }

  const segments = splitTranscript(delivered.transcript);

  // One step per segment, bounded, in an order a replay reproduces exactly.
  // A failed segment fails the RUN, deliberately: every sibling that finished is
  // already journaled, so the resume replays those for free and re-issues only
  // what is missing, where catching here to salvage a partial transcript would
  // ship a recording with a silent hole in it and report success.
  const cleaned = await mapInBatches(segments, SEGMENT_CONCURRENCY, (text) =>
    postProcess(text, input.redact),
  );

  const transcript = cleaned.join(" ");

  // Whatever this returns is what a caller reads as `output` on a completed run
  // — so it is what the page renders, typed through `WorkflowOutputOf`.
  return {
    filename: input.upload.name,
    jobId,
    segments: segments.length,
    words: countWords(transcript),
    transcript,
    filedAt: await file(input.requestedBy, input.upload.name),
  };
}

/**
 * Hand the recording to the transcription provider, with the URL to call back.
 *
 * **The stub delivers its own callback**, which a real one obviously does not:
 * this is where a `fetch` to a transcription API's `POST /v2/transcript` with a
 * `webhook_url` would go, returning the moment the provider accepts the job. The
 * stub instead posts the finished transcript to `hook.url` itself, so the
 * template runs end to end with no account, no credential and no stored audio —
 * and so the fast-callback race the module doc describes is exercised on every
 * run rather than being a paragraph nobody tests.
 *
 * Note what it could NOT do today: reach `ctx.env` for an API key. A step is
 * bundled and dispatched separately from the agent bundle and is handed no tool
 * context, and the guest keeps the agent's secrets in memory rather than in
 * `process.env`. That gap is why this is a stub and not a `fetch` to a real
 * provider, and it is the same reason `research-desk`'s `gather` is one.
 */
export async function submitTranscriptionJob(upload: Upload, callbackUrl: string): Promise<string> {
  "use step";

  await report(`Submitting ${upload.name} for transcription.`);

  if (upload.size <= 0) {
    // An empty recording is not a transient fault, and retrying it three times
    // only delays the same answer.
    throw new FatalError(`"${upload.name}" is empty — nothing to transcribe`);
  }

  // Derived from the upload rather than minted, so a RETRY of this step submits
  // the same job id — which is what the run's own delivery check compares
  // against. A random id would fail that check on every attempt but the first.
  const jobId = `job_${upload.size}_${upload.name.replace(/\W+/g, "-").toLowerCase()}`;

  // The simulated provider. `callbackUrl` is `hook.url`, which is dialable from
  // inside this container and nowhere else — see the module doc for what a real
  // provider is handed instead.
  const response = await fetch(callbackUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId, transcript: fakeTranscript(upload) }),
  });
  if (!response.ok) {
    // A plain throw (unlike the `FatalError`s above) is what a transient fault
    // wants: the DevKit retries a step, and a webhook endpoint answering 5xx
    // while the run is still committing its registration is exactly the kind of
    // failure that clears on its own.
    throw new Error(`Callback delivery failed: HTTP ${response.status}`);
  }

  return jobId;
}

/**
 * Retries beyond the default 3, because a rate limit is the expected failure.
 */
submitTranscriptionJob.maxRetries = 5;

/**
 * Post-process one segment of the transcript.
 *
 * One step per segment, so a run that dies part-way resumes having replayed the
 * finished ones from the journal — no re-reading, no re-billing — and issues
 * exactly the calls that are missing.
 */
export async function postProcess(segment: string, redact: boolean): Promise<string> {
  "use step";

  // One line per segment, which is what makes the fan-out legible to a page: the
  // status is `running` for the whole batch, so without this a twelve-segment
  // recording and a one-segment recording look identical while they run.
  //
  // ORDER is not guaranteed here and does not need to be. A batch issues its
  // calls together, so their lines interleave by completion — the page renders a
  // log, not a sequence, and `splitTranscript`'s indices are what put the
  // TRANSCRIPT back in order.
  await report(`Cleaning up a ${segment.split(/\s+/).length}-word segment.`);

  // Stands in for whatever a real desk does per segment — speaker attribution, a
  // model pass, a redaction service. The whole Node runtime is available in a
  // step, unlike in the body above.
  return redact ? redactPii(segment) : segment;
}

/**
 * File the finished transcript, and report when.
 *
 * Separate from the segment steps on purpose: a crash between the last segment
 * and the filing replays every segment for free and re-issues only the filing.
 * One step doing both would redo the expensive half whenever the cheap half
 * failed.
 */
export async function file(_requestedBy: string, _filename: string): Promise<string> {
  "use step";

  await report("Filing the transcript.");
  // A real desk would write to its database here, keyed on the two names above
  // — the `_` says this stub writes nothing. It takes the two IDENTIFIERS and
  // not the transcript itself, which is the module doc's rule about step
  // arguments: they are serialized onto a queue, so pass an id, not a payload.
  // Returning the timestamp rather than reading a clock in the BODY is the
  // journaling rule again: a step's result is stable across replays where a
  // clock read in the body is not.
  return new Date().toISOString();
}

// ---- Pure helpers -----------------------------------------------------------
//
// Everything below is a pure function of a journaled value, which is what makes
// it legal in (or under) the body: it computes the same answer on every replay.

/** Split a transcript into fixed-size segments, keeping word boundaries. */
export function splitTranscript(transcript: string): string[] {
  const words = transcript.split(/\s+/).filter(Boolean);
  const segments: string[] = [];
  for (let from = 0; from < words.length; from += SEGMENT_WORDS) {
    segments.push(words.slice(from, from + SEGMENT_WORDS).join(" "));
  }
  return segments;
}

/** Words in a string. */
function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Mask the two identifiers a transcript most often leaks. */
function redactPii(segment: string): string {
  return segment
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, "[email]")
    .replace(/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g, "[phone]");
}

/**
 * A stand-in transcript, derived from the upload so the template needs no stored
 * audio.
 *
 * Deterministic on purpose — a step may legitimately be non-deterministic, but a
 * FIXTURE that changed per call would make the segment count differ between a
 * run and its own retry, which reads as a workflow bug rather than a fixture one.
 */
function fakeTranscript(upload: Upload): string {
  // Roughly a minute of speech per 100 KB, capped so a large upload does not
  // fan out into hundreds of steps in a template.
  const sentences = Math.min(24, Math.max(2, Math.round(upload.size / 100_000) + 2));
  return Array.from(
    { length: sentences },
    (_unused, index) =>
      `Segment ${index + 1} of ${upload.name}: this is where the transcribed speech would be, ` +
      "reach us at desk@example.com or 555-010-9999 if anything looks wrong.",
  ).join(" ");
}
