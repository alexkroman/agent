import agentDef from "virtual:aai/agent";
import type {
  DialogBargeIn,
  DialogPosition,
  DialogSessionEventName,
  DialogStateSpec,
  DialogTimeout,
  DialogToolResult,
  DialogVoiceConfig,
  SlotHolder,
  TelephonyCarrier,
  ToolContext,
} from "@alexkroman1/aai";
import { isToolFailure } from "@alexkroman1/aai";
import type { SessionEvent } from "@alexkroman1/aai/protocol";
import {
  createToolContext,
  dialogRefusalPattern,
  expectDialogOk,
  expectDialogRefused,
  runTool,
  toolOf,
} from "@alexkroman1/aai/testing";
import { beforeEach, describe, expect, test } from "vitest";
import { CALL_SPEC, roadsideCall } from "./call.ts";
import { DESK_EVENTS, LOGGED_EVENTS } from "./events.ts";
import {
  disclosureFor,
  LOG_CAP,
  NON_MEMBER,
  PLANS,
  quoteFee,
  rateFor,
  roadsideSlot,
} from "./shared.ts";
import acknowledgeDisclosure from "./tools/acknowledge_disclosure.ts";
import dispatchTruck from "./tools/dispatch_truck.ts";
import jobStatus from "./tools/job_status.ts";
import lookupCoverage from "./tools/lookup_coverage.ts";
import reportLocation from "./tools/report_location.ts";
import serviceDisclosure from "./tools/service_disclosure.ts";
import { resetYard } from "./yard.ts";

/**
 * The fleet is not per-session — it is the depot's, shared by every call — so a
 * suite that dispatches in more than one test has to hand the trucks back
 * between them, exactly as it would reset any other external resource it stubs.
 * `yard.ts` says why the board lives outside the slot; `yard.test.ts` is what
 * drives the contention it exists for.
 */
beforeEach(resetYard);

/**
 * Where the call is, without going through a tool.
 *
 * These four read the dialog and nothing else, so they take a
 * {@link SlotHolder} — the `{ slots, sessionId }` pair every `Dialog` method
 * asks for — rather than a whole `ToolContext`. A `TestToolContext` satisfies
 * it, and naming the narrower type is what says a position read needs no model,
 * no workflows client and no way to speak.
 */
const at = (ctx: SlotHolder): DialogPosition => roadsideCall.position(ctx);

/**
 * The deadline declared where the call currently is — a READ, not a timer.
 *
 * This is the same call the runtime makes once per turn before arming its own
 * `setTimeout`, so asserting on it is asserting on what the session will do.
 * Nothing here starts a clock, which is why these tests can be in the unit tier.
 */
const deadlineAt = (ctx: SlotHolder): DialogTimeout | undefined => roadsideCall.timeout(ctx);

/** The voice settings in force where the call is — deepest declaring state wins. */
const knobsAt = (ctx: SlotHolder): DialogVoiceConfig | undefined => roadsideCall.voiceConfig(ctx);

/** How interruptible the agent is right here. See `UNINTERRUPTIBLE` in `call.ts`. */
const bargeInAt = (ctx: SlotHolder): DialogBargeIn | undefined => knobsAt(ctx)?.bargeIn;

/**
 * The session events this dialog declares a transition on, each paired with the
 * WIRE event the runtime would offer for it.
 *
 * The two halves are related by exactly one rule — a `DialogSessionEventName`
 * is a wire event type under a leading `@` — and nothing checks that a pair
 * still agrees, so the first test below does. Getting it wrong is silent: an
 * `@` name that is not a session event is refused at declaration, but a pair
 * that has drifted here would simply drive the wrong event and pass.
 */
const WIRED: readonly { declared: DialogSessionEventName; event: SessionEvent }[] = [
  {
    declared: "@user-transcript.committed",
    event: {
      type: "user-transcript.committed",
      text: "I'm on the shoulder of route nine",
      meta: { id: "evt_1", at: 0 },
    },
  },
  {
    declared: "@session.timed-out",
    event: { type: "session.timed-out", meta: { id: "evt_2", at: 0 } },
  },
];

const HEARD_SOMETHING = WIRED[0]!.event;
const CALLER_GONE = WIRED[1]!.event;

/**
 * Every state in a dialog spec, parents included, as `<parent>.<child>` paths.
 *
 * Typed with {@link DialogStateSpec} rather than read off the `as const`
 * literal: the annotation is what makes the recursion legal (a state's
 * `states` is the same shape) and what says the two fields audited below are
 * ones the SDK really accepts — a spec that dropped `voice` from the type
 * would fail here rather than leave the audit passing over a field nothing
 * can declare any more.
 */
function eachState(
  states: Readonly<Record<string, DialogStateSpec>>,
  prefix = "",
): [string, DialogStateSpec][] {
  return Object.entries(states).flatMap(([name, spec]) => {
    const path = prefix === "" ? name : `${prefix}.${name}`;
    const here: [string, DialogStateSpec] = [path, spec];
    return [here, ...eachState(spec.states ?? {}, path)];
  });
}

const A_LOCATION = {
  where: "eastbound route nine, just past the exit for Millfield",
  landmark: "the boarded-up diner",
  safeToWait: true,
  situation: "wont_start",
  make: "Toyota",
  model: "Corolla",
  color: "silver",
} as const;

/** Walk the call to `onCall.verifying`. */
async function locate(ctx: ToolContext): Promise<void> {
  expectDialogOk(await reportLocation.execute(A_LOCATION, ctx));
}

/** Walk it on to `onCall.disclosure`, on the plan `policyNumber` names. */
async function verify(ctx: ToolContext, policyNumber?: string): Promise<void> {
  await locate(ctx);
  expectDialogOk(
    await lookupCoverage.execute(policyNumber === undefined ? {} : { policyNumber }, ctx),
  );
}

/** And on to `onCall.dispatching`, with the fee accepted. */
async function accept(ctx: ToolContext, policyNumber?: string): Promise<void> {
  await verify(ctx, policyNumber);
  expectDialogOk(await acknowledgeDisclosure.execute({ accepted: true }, ctx));
}

/** What `dispatch_truck` answers with, as the specs below read it. */
interface JobLine {
  callsign: string;
  etaMinutes: number;
  alreadyDispatched: boolean;
}

/**
 * Send the truck, and hand back the WHOLE envelope a gated tool answers with.
 *
 * The return is annotated {@link DialogToolResult} because that envelope is
 * written by `roadsideCall.tool` rather than by the tool body — `result`, plus
 * the `state`/`done`/`instruction` the dialog wraps around it — and four specs
 * below read both halves. Naming it once is what stops each of them restating
 * the shape.
 */
async function sendTruck(
  ctx: ToolContext,
  destination = "Millfield Auto",
  towMiles = 31,
): Promise<DialogToolResult<JobLine>> {
  return expectDialogOk<JobLine>(await dispatchTruck.execute({ destination, towMiles }, ctx));
}

describe("the roadside call", () => {
  test("a fresh call is locating, and every later phase's tool refuses there", async () => {
    const ctx = createToolContext();
    expect(at(ctx).state).toBe("onCall.locating");
    expect(at(ctx).instruction).toMatch(/report_location/);

    for (const call of [
      lookupCoverage.execute({ policyNumber: "RS-4417" }, ctx),
      serviceDisclosure.execute({}, ctx),
      acknowledgeDisclosure.execute({ accepted: true }, ctx),
      dispatchTruck.execute({ destination: "nearest approved shop", towMiles: 4 }, ctx),
    ]) {
      // `expectDialogRefused` pins the GATE's own sentence, built once in the
      // SDK and matched from there — and it throws on a SUCCESS, which the
      // `isToolFailure(x) && x.error` shape it replaces quietly let through.
      const refusal = expectDialogRefused(await call, "onCall.locating");
      // The refusal quotes the state's own instruction, which is the model's
      // recovery path — it names the tool to call instead.
      expect(refusal.error).toMatch(/report_location/);
    }

    // And nothing ran: a refusal must not have touched the call.
    expect(roadsideSlot.get(ctx).where).toBeNull();
  });

  test("reporting the location moves the call to verifying and latches the vehicle", async () => {
    const ctx = createToolContext();
    const result = expectDialogOk<{ vehicle: string; safeToWait: boolean }>(
      await reportLocation.execute(A_LOCATION, ctx),
    );

    expect(result.state).toBe("onCall.verifying");
    expect(result.result.vehicle).toBe("silver Toyota Corolla");
    expect(roadsideSlot.get(ctx).situation).toBe("wont_start");
  });

  test("a policy number nothing matches refuses, and the call does not move", async () => {
    const ctx = createToolContext();
    await locate(ctx);

    const refused = await lookupCoverage.execute({ policyNumber: "RS-0000" }, ctx);
    expect(isToolFailure(refused) && refused.error).toMatch(/RS-0000/);
    // A BODY failure, and NOT a gate refusal — the tool was perfectly legal
    // here and said no. The two are the same `ToolFailure` to a caller and
    // completely different things to the desk, so the spec says which it is.
    expect(isToolFailure(refused) && refused.error).not.toMatch(dialogRefusalPattern());
    // The half that matters: a gated tool sends nothing when its body answers a
    // failure, so a misheard digit cannot leave the caller quoted at a rate
    // nobody looked up.
    expect(at(ctx).state).toBe("onCall.verifying");
    expect(roadsideSlot.get(ctx).coverage).toBeNull();
  });

  test("a policy number read out with noise in it still matches", async () => {
    const ctx = createToolContext();
    await locate(ctx);
    const result = expectDialogOk<{ plan: string; holder: string | null }>(
      await lookupCoverage.execute({ policyNumber: "rs 4417" }, ctx),
    );
    expect(result.result.plan).toBe(PLANS.plus.name);
    expect(result.result.holder).toBe("Dana Whitfield");
  });

  test("no policy number at all is an ANSWER: the call moves, priced as a non-member", async () => {
    const ctx = createToolContext();
    await locate(ctx);

    const result = expectDialogOk<{ plan: string; status: string; callOut: number }>(
      await lookupCoverage.execute({}, ctx),
    );
    expect(result.state).toBe("onCall.disclosure");
    expect(result.result.status).toBe("unverified");
    expect(result.result.callOut).toBe(NON_MEMBER.callOut);
  });

  test("a lapsed policy is found and still priced as a non-member", async () => {
    const ctx = createToolContext();
    await verify(ctx, "RS-1290");

    // Found — the holder's name comes back — and charged the call-out anyway.
    expect(roadsideSlot.get(ctx).coverage?.holder).toBe("Priya Raghavan");
    expect(rateFor(roadsideSlot.get(ctx).coverage)).toBe(NON_MEMBER);
  });

  test("declining the fee leaves the call in disclosure; accepting moves it on", async () => {
    const ctx = createToolContext();
    await verify(ctx, "RS-4417");
    expect(at(ctx).state).toBe("onCall.disclosure");

    // `sendFrom` returning `undefined` is "that worked and it moved nothing" —
    // not a failure, because declining a fee is not an error.
    const declined = expectDialogOk<{ accepted: boolean }>(
      await acknowledgeDisclosure.execute({ accepted: false }, ctx),
    );
    expect(declined.result.accepted).toBe(false);
    expect(declined.state).toBe("onCall.disclosure");
    expect(roadsideSlot.get(ctx).disclosureAcceptedAt).toBeNull();

    const agreed = expectDialogOk(await acknowledgeDisclosure.execute({ accepted: true }, ctx));
    expect(agreed.state).toBe("onCall.dispatching");
  });

  test("the disclosure is handed over verbatim and priced by the plan", async () => {
    const ctx = createToolContext();
    await verify(ctx, "RS-8802");

    const read = expectDialogOk<{ readThisVerbatim: string; wordCount: number }>(
      await serviceDisclosure.execute({}, ctx),
    );
    expect(read.result.readThisVerbatim).toBe(disclosureFor(roadsideSlot.get(ctx).coverage));
    expect(read.result.readThisVerbatim).toContain(PLANS.basic.name);
    expect(read.result.wordCount).toBeGreaterThan(40);
    // A read that changes nothing: it must not have moved the call off the one
    // state whose `bargeIn: "off"` is what gets these words said in full.
    expect(read.state).toBe("onCall.disclosure");
  });

  test("dispatch is idempotent: a second call reports the same truck", async () => {
    const ctx = createToolContext();
    await accept(ctx, "RS-4417");

    const first = await sendTruck(ctx);
    expect(first.result.alreadyDispatched).toBe(false);

    // The state pins the model to this tool, so it fires again on every later
    // step. A second truck would be a fleet; the same job is the contract.
    const second = await sendTruck(ctx, "somewhere else entirely", 400);
    expect(second.result.alreadyDispatched).toBe(true);
    expect(second.result.callsign).toBe(first.result.callsign);
    expect(roadsideSlot.get(ctx).job?.destination).toBe("Millfield Auto");
  });

  test("the tow is priced by the plan the lookup found, not by the one it might have", async () => {
    const covered = createToolContext();
    await accept(covered, "RS-4417");
    await sendTruck(covered, "shop");

    const uncovered = createToolContext();
    await accept(uncovered);
    await sendTruck(uncovered, "shop");

    // Plus covers 25 miles and charges $3 for the other six; a non-member pays
    // the call-out plus $7 for all 31. The template computes both through the
    // one `quoteFee`, which is why the disclosure and the invoice cannot drift.
    expect(roadsideSlot.get(covered).job?.quote.total).toBe(quoteFee(PLANS.plus, 31).total);
    expect(roadsideSlot.get(uncovered).job?.quote.total).toBe(quoteFee(NON_MEMBER, 31).total);
    expect(roadsideSlot.get(covered).job?.quote.total).toBeLessThan(
      roadsideSlot.get(uncovered).job?.quote.total ?? 0,
    );
  });

  test("an unsafe caller is moved up the queue, and no ETA is ever below the floor", async () => {
    const ctx = createToolContext();
    expectDialogOk(
      await reportLocation.execute({ ...A_LOCATION, safeToWait: false, situation: "battery" }, ctx),
    );
    expectDialogOk(await lookupCoverage.execute({}, ctx));
    expectDialogOk(await acknowledgeDisclosure.execute({ accepted: true }, ctx));
    const job = await sendTruck(ctx, "roadside", 0);
    expect(job.result.etaMinutes).toBe(10);
  });
});

describe("the two deadlines", () => {
  test("locating carries a silence deadline, and the nudge is where it lands", () => {
    const ctx = createToolContext();
    const deadline = deadlineAt(ctx);

    expect(deadline?.afterMs).toBe(12_000);
    expect(deadline?.event).toEqual({ type: "QUIET" });

    // Firing it is what the runtime does when the window passes.
    expect(roadsideCall.send(ctx, { type: "QUIET" }).state).toBe("onCall.quiet");
    expect(at(ctx).instruction).toMatch(/still there/);
  });

  test("the nudge state arms nothing: the next rung is the session's own idle timeout", () => {
    const ctx = createToolContext();
    roadsideCall.send(ctx, { type: "QUIET" });
    expect(deadlineAt(ctx)).toBeUndefined();
  });

  test("hearing the caller puts the ladder back on its first rung", () => {
    const ctx = createToolContext();
    roadsideCall.send(ctx, { type: "QUIET" });
    expect(roadsideCall.receive(ctx, HEARD_SOMETHING).state).toBe("onCall.locating");
    // Back on the rung that declares the window, which is what the runtime
    // re-arms from: the clock runs from the dialog's last MOVE.
    expect(deadlineAt(ctx)?.event).toEqual({ type: "QUIET" });
  });

  test("verifying's deadline is wall clock — nothing the caller says extends it", async () => {
    const ctx = createToolContext();
    await locate(ctx);

    expect(deadlineAt(ctx)?.afterMs).toBe(120_000);
    // The half that is a claim about the SPEC rather than about a number: this
    // phase declares no transition on chatter, so a caller who talks the whole
    // two minutes moves the dialog not at all — and a dialog that has not moved
    // is a deadline that has not been re-armed.
    const before = at(ctx).state;
    expect(roadsideCall.receive(ctx, HEARD_SOMETHING).state).toBe(before);
  });

  test("the verification deadline gives up INTO the disclosure, at the non-member rate", async () => {
    const ctx = createToolContext();
    await locate(ctx);

    expect(roadsideCall.send(ctx, { type: "UNVERIFIED" }).state).toBe("onCall.disclosure");
    const read = expectDialogOk<{ readThisVerbatim: string }>(
      await serviceDisclosure.execute({}, ctx),
    );
    // A caller we could not confirm is still stranded. What they lost is the
    // discount, not the truck.
    expect(read.result.readThisVerbatim).toContain("non-member");
  });
});

describe("the session events", () => {
  test("each `@` name is the wire type this dialog is really offered", () => {
    for (const { declared, event } of WIRED) {
      expect(declared).toBe(`@${event.type}`);
    }
  });

  test("a hang-up ends the call from any phase, and every tool refuses after it", async () => {
    for (const reach of [locate, verify, accept]) {
      const ctx = createToolContext();
      await reach(ctx);

      const position = roadsideCall.receive(ctx, CALLER_GONE);
      expect(position.state).toBe("abandoned");
      expect(position.done).toBe(true);

      // `abandoned` is final, so it delivers no events and no tool declares
      // itself legal there — including the read, which is gated on the parent
      // rather than left ungated for exactly this.
      expectDialogRefused(await jobStatus.execute({}, ctx), "abandoned");
      expectDialogRefused(
        await dispatchTruck.execute({ destination: "shop", towMiles: 1 }, ctx),
        "abandoned",
      );
    }
  });

  test("a session event no active state declares moves nothing", async () => {
    const ctx = createToolContext();
    await accept(ctx, "RS-4417");
    // `onCall.dispatching` declares no transition on speech, and the parent's
    // only session event is the hang-up. An unhandled event is IGNORED.
    expect(roadsideCall.receive(ctx, HEARD_SOMETHING).state).toBe("onCall.dispatching");
  });
});

describe("the per-phase voice knobs", () => {
  test("the disclosure is uninterruptible, and it is the only phase that is", async () => {
    const ctx = createToolContext();
    expect(bargeInAt(ctx)).toEqual({ minWords: 1 });

    await verify(ctx, "RS-4417");
    expect(bargeInAt(ctx)).toBe("off");

    expectDialogOk(await acknowledgeDisclosure.execute({ accepted: true }, ctx));
    expect(bargeInAt(ctx)).toBeUndefined();
  });

  test("verifying pins a low temperature and nothing else", async () => {
    const ctx = createToolContext();
    await locate(ctx);
    expect(knobsAt(ctx)).toEqual({ temperature: 0.2 });
  });

  test("dispatching pins the model to the tool that actually sends a truck", async () => {
    const ctx = createToolContext();
    await accept(ctx, "RS-4417");
    expect(knobsAt(ctx)?.toolChoice).toEqual({ type: "tool", toolName: "dispatch_truck" });
  });

  test("no state declares a knob the runtime cannot apply", () => {
    // `voice` and `keyterms` are accepted by `DialogStateSpec` and implemented
    // by NEITHER transport — the runtime warns at the first session and applies
    // nothing. A template that declared one would be documenting a promise the
    // SDK does not keep, which is worse than leaving the knob unexercised.
    //
    // Read off the SPEC rather than walked by sending events, which is what
    // makes the claim cover `abandoned` — a final state no walk can reach and
    // the one a sixth phase would be added beside.
    const audited = eachState(CALL_SPEC.states);
    for (const [path, spec] of audited) {
      expect({ at: path, voice: spec.voice, keyterms: spec.keyterms }).toEqual({
        at: path,
        voice: undefined,
        keyterms: undefined,
      });
    }

    // Non-vacuity, and the reason the walk is structural: every state in the
    // tree, parents included, and a new one joins this list or fails here.
    expect(audited.map(([path]) => path)).toEqual([
      "onCall",
      "onCall.locating",
      "onCall.quiet",
      "onCall.verifying",
      "onCall.disclosure",
      "onCall.dispatching",
      "abandoned",
    ]);
  });
});

describe("what the desk is REACHED by, and what it writes down", () => {
  test("the phone route is mounted, for exactly the carriers the numbers are with", () => {
    // `telephony` is an ALLOW-LIST whose default is empty: without this
    // declaration `WS /phone` is not served, and a roadside desk nobody can
    // dial is not a roadside desk. The carriers are named as
    // `TelephonyCarrier`s so a third one added to `agent.ts` and not here
    // fails at compile time rather than as a refused upgrade.
    const carriers: readonly TelephonyCarrier[] = ["twilio", "telnyx"];
    expect(agentDef.telephony).toEqual(carriers);
  });

  test("the hooks the agent declares are exactly the ones the desk logs", () => {
    expect(agentDef.events).toBe(DESK_EVENTS);
    expect(Object.keys(DESK_EVENTS)).toEqual([...LOGGED_EVENTS]);
  });

  test("a hang-up and a line fault are recorded by hooks, which no tool can do", async () => {
    const ctx = createToolContext();
    await accept(ctx, "RS-4417");
    await sendTruck(ctx);
    const before = roadsideSlot.get(ctx).log.length;

    DESK_EVENTS["error.reported"]?.(
      {
        type: "error.reported",
        code: "stt",
        message: "transcriber dropped the stream",
        fatal: false,
        meta: { id: "evt_stt", at: 0 },
      },
      ctx,
    );
    DESK_EVENTS["session.timed-out"]?.(
      { type: "session.timed-out", meta: { id: "evt_gone", at: 0 } },
      ctx,
    );

    const log = roadsideSlot.get(ctx).log;
    expect(log).toHaveLength(before + 2);
    // The fatal/non-fatal split is the whole reason the line says which it
    // was: a caller cut off mid-disclosure and one whose transcription
    // hiccuped are the same silence on a recording.
    expect(log.at(-2)).toBe("Line trouble (stt, recovered): transcriber dropped the stream");
    expect(log.at(-1)).toMatch(/Caller gone/);
  });

  test("the log is bounded where the slot says, and the OLDEST line is what goes", () => {
    const ctx = createToolContext();
    // A `SlotCaps` entry is optional per key, so the bound is read rather than
    // assumed — and asserted non-zero, or the overflow below proves nothing.
    const cap = LOG_CAP.log ?? 0;
    expect(cap).toBeGreaterThan(0);

    const overflow = cap + 6;
    for (let n = 0; n < overflow; n += 1) {
      DESK_EVENTS["error.reported"]?.(
        {
          type: "error.reported",
          code: "connection",
          message: `fault ${n}`,
          fatal: false,
          meta: { id: `evt_${n}`, at: 0 },
        },
        ctx,
      );
    }

    const log = roadsideSlot.get(ctx).log;
    expect(log).toHaveLength(cap);
    expect(log[0]).toContain(`fault ${overflow - cap}`);
    expect(log.at(-1)).toContain(`fault ${overflow - 1}`);
  });
});

describe("the registered surface", () => {
  test("job_status reports the call, in the envelope the dialog wraps it in", async () => {
    const ctx = createToolContext();
    await accept(ctx, "RS-4417");
    await sendTruck(ctx);

    const status = expectDialogOk<{
      plan: string;
      feeDisclosureAccepted: boolean;
      job: { callsign: string } | null;
    }>(await jobStatus.execute({}, ctx));

    expect(status.result.plan).toBe(PLANS.plus.name);
    expect(status.result.feeDisclosureAccepted).toBe(true);
    expect(status.result.job?.callsign).toBe("Flat-2");
    // The three fields `roadsideCall.tool` writes around every result, and how
    // the model re-reads its own position after a turn that called nothing.
    expect(status.state).toBe("onCall.dispatching");
    expect(status.done).toBe(false);
    expect(status.instruction).toMatch(/dispatch_truck/);
  });

  test("the dispatching pin names a tool the agent really registers", async () => {
    const ctx = createToolContext();
    await accept(ctx, "RS-4417");

    const pin = knobsAt(ctx)?.toolChoice;
    const pinned = typeof pin === "object" ? pin.toolName : "";
    // `toolOf` throws when the registry has no such tool, which is the claim:
    // `tools/dispatch_truck.ts` could be renamed and every other test in this
    // file would go on passing while the pin named nothing.
    expect(toolOf(agentDef, pinned)).toBe(dispatchTruck);

    // And run it BY THAT NAME, through the agent's own table and its schema —
    // the path the model takes, which calling `.execute` directly skips.
    const ran = expectDialogOk<JobLine>(
      await runTool(agentDef, pinned, { destination: "Millfield Auto", towMiles: 31 }, ctx),
    );
    expect(ran.result.alreadyDispatched).toBe(false);
  });
});

describe("the agent declaration", () => {
  test("the dialog is DECLARED on the agent, which is what wires all of the above", () => {
    // The one line this whole template rests on. An undeclared dialog still
    // gates its tools and still moves on `send`, so every test above would go
    // on passing while the deadlines were never armed, the session events
    // reached nothing, the per-phase instruction reached the model only on
    // turns that happened to call a tool, and the three knobs were read by
    // nobody. There is no other assertion in this file that can see that.
    expect(agentDef.dialogs).toContain(roadsideCall);
  });
});
