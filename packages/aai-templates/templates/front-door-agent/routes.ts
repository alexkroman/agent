import { hashCode, mintDigitCode, route, routeError, webhookRoute } from "@alexkroman1/aai";
import {
  CLIENT_ID,
  PAIR_CODE_DIGITS,
  PAIR_WINDOW_MS,
  type PairStarted,
  type PairStatus,
} from "./shared.ts";
import announce from "./workflows/announce.ts";
import digest from "./workflows/digest.ts";
import pair from "./workflows/pair.ts";

/** A day, for "today" in the digest: the last twenty-four hours. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * POST /api/pair — an unlinked phone asks for a code to read to the door.
 *
 * The code is minted here and shown once; only its hash is kept, as the KEY of the run that
 * waits for the door (workflows/pair.ts), so the door finds the run by hashing what it
 * heard. An unused code simply expires with its window.
 */
export const pairPhone = route({
  requireClient: true,
  handler: async (req, ctx): Promise<PairStarted> => {
    const code = mintDigitCode(PAIR_CODE_DIGITS);
    const runId = await ctx.workflows.start(
      pair,
      { phoneId: req.clientId },
      { key: await hashCode(code), label: "Linking a phone" },
    );
    return { runId, code, expiresAt: Date.now() + PAIR_WINDOW_MS };
  },
});

/**
 * GET /api/pair/:runId — has the door heard the code yet? The door's id is answered only
 * to the phone that asked for the code: anyone else gets a 404, as for a run that is not
 * there.
 */
export const pairStatus = route({
  requireClient: true,
  handler: async (req, ctx): Promise<PairStatus> => {
    const run = await ctx.workflows.get(req.params.runId ?? "", pair);
    if (run === undefined || run.workflow !== "pair") throw routeError(404, "No such link");
    if (run.status !== "completed") {
      return run.status === "pending" || run.status === "running"
        ? { status: "waiting" }
        : { status: "expired" };
    }
    if (run.output.phoneId !== req.clientId) throw routeError(404, "No such link");
    return run.output.linked
      ? { status: "linked", doorId: run.output.doorId }
      : { status: "expired" };
  },
});

/**
 * POST /api/digest — the linked phone asks for today's summary. The phone sends the
 * door's id (it is the door's twin), and the summary comes back to the same inbox.
 */
export const askDigest = route({
  requireClient: true,
  handler: async (req, ctx) => {
    const runId = await ctx.workflows.start(
      digest,
      { doorId: req.clientId, since: Date.now() - DAY_MS },
      { key: req.clientId, label: "Today at the door" },
    );
    return { runId };
  },
});

/**
 * POST /api/ring — the doorbell HARDWARE: a button that posts `{ "door": "<client id>" }`
 * as a Standard Webhooks delivery signed with DOORBELL_WEBHOOK_SECRET. webhookRoute
 * answers 401 to an unsigned or stale delivery before this runs, and 500 naming the
 * variable when it is unset, so a ring can only come from something holding the secret.
 */
export const ring = webhookRoute({ secretEnv: "DOORBELL_WEBHOOK_SECRET" }, async (req, ctx) => {
  const door = (req.body as { door?: unknown } | undefined)?.door;
  if (typeof door !== "string" || !CLIENT_ID.test(door)) {
    throw routeError(400, 'Send { "door": "<the door\'s client id>" }');
  }
  const runId = await ctx.workflows.start(
    announce,
    { doorId: door, notice: { kind: "ring" } },
    { key: door, label: "The bell rang" },
  );
  return { runId };
});
