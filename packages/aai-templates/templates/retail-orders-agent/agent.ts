import { agent, type LowConfidencePolicy } from "@alexkroman1/aai";
import { assemblyAIStt } from "@alexkroman1/aai/stt";
import { RETAIL_KEYTERMS } from "./keyterms.ts";
import { storeView } from "./shared.ts";
import { callFlow, gateFor, record, retailSlot } from "./store.ts";

/**
 * What to do when the recognizer itself is unsure of a caller's turn.
 *
 * `note` rather than the default `clarify`, and the choice is a property of
 * THIS agent rather than a preference: every change here is staged and read
 * back before it happens (`awaitingConfirmation` in `store.ts`), so the
 * conversation already has a place to verify a shaky identifier — and telling
 * the model the words may be wrong lets it fold the check into that read-back
 * instead of spending a turn on "could you repeat that?". An agent with no
 * confirmation step should leave the default alone.
 *
 * The thresholds are the shipped ones (drop under 0.2, note between 0.2 and
 * 0.4) and are NOT tuned for this domain — nobody has measured them here. The
 * statistic they read is the mean of the turn's per-word confidences; the
 * `minWord` reading is the one that would catch a single mis-heard digit in an
 * otherwise clean sentence, and choosing it means lowering both numbers.
 */
const LOW_CONFIDENCE: LowConfidencePolicy = { action: "note" };

export default agent({
  name: "Retail Support",
  description: "Looks up orders, returns and store credit for an authenticated retail caller",

  /**
   * A per-session ceiling on what the model may spend.
   *
   * This is the template where a budget earns its place: authentication, an
   * order lookup and a staged change are three tool chains deep, the store's
   * projection is large, and a caller who keeps re-asking can run a session for
   * as long as they like. `maxSteps` bounds a REPLY and says nothing about a
   * call — one step that sends a 100k-token context and one that sends a
   * greeting are the same step.
   *
   * Tokens rather than money: a price is per-model and per-contract, and the
   * SDK carries no table of them (see `UsageLimits`). The number here is a
   * generous ceiling for a support call, not a target — pick yours from what
   * `usage.updated` reports on a real conversation.
   *
   * Reaching it ends the session. An agent that wants a softer landing watches
   * `usage.updated` through `agent({ events })` and says something first.
   */
  usageLimits: { totalTokens: 200_000 },

  // Pipeline mode is the default and an unset stage is filled from the
  // all-AssemblyAI pipeline at parse time, so only `stt` is named here; `llm`
  // and `tts` take the defaults.
  //
  // What it names is the domain's own vocabulary (`keyterms.ts`), which is the
  // cheapest thing available against this template's worst failure: a
  // mis-heard product or option becomes a tool argument that resolves to the
  // wrong item, or to nothing, and the transcript reads perfectly either way.
  // Two other steering mechanisms are already on by default and need no
  // declaration — the contextual `agent_context`, refreshed with the agent's
  // own last reply after every turn, and the endpointing window that lets a
  // caller pause mid-identifier.
  //
  // This list is the one that holds for the WHOLE call. The other one is per
  // phase: `callFlow`'s `identifying` state boosts the account NAMES instead,
  // for as long as the call is working out who is on the line, and gives them
  // back when it moves on (`IDENTIFYING_KEYTERMS` in `keyterms.ts`). A name is
  // the hardest thing here to recognize and the least useful thing to boost
  // once it is known.
  stt: assemblyAIStt({ keyterms: [...RETAIL_KEYTERMS] }),

  lowConfidence: LOW_CONFIDENCE,

  // The store lives in one `sessionSlot` (`store.ts`), a pristine copy per
  // session — callers must not see each other's cancellations. Nothing declares
  // it here: the slot installs itself on first access, and its `projection`
  // below is what gives a session that has run no tool something to render.

  // One projection pushed after every tool call. It is a projection, not a
  // flag, because the state holds all six seeded customers and only the
  // authenticated one may reach the browser.
  syncState: retailSlot.projection(storeView),

  /**
   * Declaring the flow is what lets the CALL move it, not just a tool.
   *
   * `callFlow` gated tools without this and still would; what the declaration
   * adds is the half no tool can reach — `"@session.timed-out"` carries a call
   * whose caller has hung up into `abandoned`, and `awaitingConfirmation`'s
   * `temperature` applies to the turn that reads a staged change back. Both
   * happen when no tool is running, which is exactly why neither was
   * expressible before.
   */
  dialogs: [callFlow],

  // Callers read order numbers and ten-digit item numbers in bursts with pauses
  // inside one utterance ("W seven six seven … eight oh seven two"). The default
  // pipeline's `max_turn_silence` already tolerates that; reach for
  // `assemblyAIStt({ maxTurnSilenceMs })` only if your callers pause longer.
  greeting:
    "Thanks for calling. Before I can look anything up I'll need to find your account — " +
    "what's the email address on it?",

  /**
   * The activity feed's blocked lines, which no tool wrapper could write.
   *
   * `retailTool` records a line per call from INSIDE the body, so it sees every
   * call the caller's own logic answered — and none that `callFlow` refused,
   * because a gated refusal short-circuits before the body. The sidebar simply
   * stopped showing the most interesting calls the model makes: the ones it
   * tried too early.
   *
   * `tool.called` is emitted by the runtime for every call the model makes, so a
   * hook is the only place that observation is available at all. It is also the
   * shape of hook this template is here to show: it WRITES the session's state
   * and it cannot speak — nothing here changes what the agent says, or stops the
   * refusal still reaching the model. It does neither.
   *
   * The gate is evaluated a second time rather than reported by the first,
   * because the refusal happens later and inside the body. That is one fact read
   * twice from one source (`gateFor`, which `retailTool` fills), not two copies
   * of it — and the only cost of the two evaluations disagreeing is a duplicate
   * or missing sidebar line, never a wrong store.
   */
  events: {
    "tool.called": (event, ctx) => {
      const when = gateFor(event.toolName);
      // Not a retail tool, or one this call may run: either way the wrapper owns
      // the line, and writing one here would double it.
      if (!when || when.some((state) => callFlow.matches(ctx, state))) return;
      const at = callFlow.position(ctx);
      retailSlot.update(ctx, (state) => {
        record(state, event.toolName, `blocked: call is at ${at.state}`);
      });
    },
  },
});
