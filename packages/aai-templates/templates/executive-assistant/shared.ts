/**
 * The assistant's inbox, its memory, the review dialog, and the projection —
 * everything both ends of the template read.
 *
 * `prompts.ts` carries the attribution and the table mapping EAIA's nodes onto
 * this template. What this file owns is the STATE their two graphs kept in
 * three places — the per-thread `State` (email, triage, messages), the store
 * (four prompts and the triage examples), and the Agent Inbox's pending
 * interrupt — as one slot, and the one position their `interrupt()` put a run
 * in, as a dialog:
 *
 * ```text
 *          open_email              draft_reply / ask_question /
 *   inbox ──────────▶ drafting ────send_calendar_invite / new_email──▶ awaitingDecision
 *     ▲    (notify goes straight    ▲                                        │
 *     │     to awaitingDecision)    └──────── respond (feedback, answer) ─────┤
 *     └──────────── accept / ignore ──────────────────────────────────────────┘
 * ```
 *
 * **Their interrupt is a spoken read-back, and their four human responses are
 * four tools.** Agent Inbox offers `accept`, `edit`, `ignore` and `respond` on
 * each halted run, with a per-interrupt `HumanInterruptConfig` saying which of
 * the four apply — a draft takes all four, a question or a notification only
 * `ignore` and `respond`. Here the assistant reads the proposal down the phone
 * and the executive answers in words; the model turns the words into one of the
 * same four tools, `awaitingDecision` is the only state they run in, and
 * {@link ALLOWED} is that config, enforced by each tool rather than by a UI
 * hiding buttons. Nothing is sent until `accept` has run.
 *
 * **Memory lives for the SESSION.** Their store outlives a run; a `sessionSlot`
 * outlives a reconnect and a redeploy, not a hang-up. Every call starts from
 * `config.yaml` and learns from its own corrections, which is the honest shape
 * for a template with no database — the sidebar's "What I've learned" panel is
 * where that shows. The upgrade is a client of your own; see "Persisting data"
 * in the SDK guide.
 */

import {
  type DeepReadonly,
  dialog,
  type SessionEventType,
  type SlotCaps,
  sessionSlot,
  spokenDate,
  spokenTime,
} from "@alexkroman1/aai";
import { DEFAULT_MEMORY, INBOX, type Memory, type SeedEmail } from "./inbox.ts";
import type { TriageExample, TriageVerdict } from "./prompts.ts";

// ─── Emails ──────────────────────────────────────────────────────────────────

export type Triage = TriageVerdict["response"];

/** How an email left the queue — their `mark_as_read`, with the reason kept. */
export type ClosedAs = "sent" | "invited" | "ignored" | "filed" | "notified";

export interface InboxEmail extends SeedEmail {
  /** Their `State.triage`, `null` until `triage_inbox` or `open_email` has run. */
  triage: TriageVerdict | null;
  /** `queued` is triaged and waiting for the executive; `open` is being worked. */
  status: "untriaged" | "queued" | "open" | "closed";
  closedAs: ClosedAs | null;
}

/** One lookup for the draft and the frozen value alike (see `dispatch-center`). */
export function findEmail<E extends { id: string }>(
  emails: readonly E[],
  id: string,
): E | undefined {
  return emails.find((email) => email.id === id);
}

// ─── Proposals ───────────────────────────────────────────────────────────────

/**
 * What is waiting on the executive's word — their `HumanInterrupt`'s
 * `action_request`, one per drafting tool plus the triage `notify` route.
 *
 * A discriminated union rather than a stored tool call: `accept` re-derives the
 * effect from it, the projection renders it, and a spec asserts on it.
 */
export type Proposal =
  | { kind: "reply"; content: string; newRecipients: string[]; toneLogic: string }
  | { kind: "new_email"; content: string; recipients: string[]; toneLogic: string }
  | {
      kind: "invite";
      emails: string[];
      title: string;
      /** `YYYY-MM-DD`, and `startTime`/`endTime` are `HH:MM` — civil, not instants. */
      date: string;
      startTime: string;
      endTime: string;
    }
  | { kind: "question"; content: string }
  | { kind: "notify" };

export type ProposalKind = Proposal["kind"];

/** Their `HumanResponse.type`, one tool each. */
export const HUMAN_RESPONSES = ["accept", "edit", "ignore", "respond"] as const;
export type HumanResponse = (typeof HUMAN_RESPONSES)[number];

/**
 * Their `HumanInterruptConfig` per interrupt: `send_email_draft` and
 * `send_cal_invite` allow all four; `send_message` (a question) and `notify`
 * allow only `ignore` and `respond`.
 */
export const ALLOWED: Record<ProposalKind, readonly HumanResponse[]> = {
  reply: HUMAN_RESPONSES,
  new_email: HUMAN_RESPONSES,
  invite: HUMAN_RESPONSES,
  question: ["ignore", "respond"],
  notify: ["ignore", "respond"],
};

/** A proposal as the sidebar and the call log show it. */
export function describeProposal(proposal: DeepReadonly<Proposal>): {
  title: string;
  body: string;
} {
  switch (proposal.kind) {
    case "reply":
      return {
        title:
          proposal.newRecipients.length > 0
            ? `Reply, adding ${proposal.newRecipients.join(", ")}`
            : "Reply",
        body: proposal.content,
      };
    case "new_email":
      return { title: `New email to ${proposal.recipients.join(", ")}`, body: proposal.content };
    case "invite":
      return {
        title: `Calendar invite: ${proposal.title}`,
        // Rendered for the EAR: the body is what the assistant reads back, and
        // a TTS engine handed `2026-03-17T14:00:00` spells the digits.
        body: `${spokenDate(proposal.date)}, ${spokenTime(proposal.startTime)} to ${spokenTime(
          proposal.endTime,
        )}, with ${proposal.emails.join(", ")}`,
      };
    case "question":
      return { title: "A question for you", body: proposal.content };
    case "notify":
      return {
        title: "Heads-up",
        body: "This email needs no reply, but you should know about it.",
      };
    // Unreachable while the union is exhausted above, and the arm a new kind
    // lands in until it has a description of its own.
    default:
      return { title: "Something is waiting", body: "" };
  }
}

// ─── Session state ───────────────────────────────────────────────────────────

/** A memory rewrite that happened on this call — their `store.aput`, remembered. */
export interface Reflection {
  memory: keyof Memory;
  logic: string;
}

/** Something that actually went out — the only writes to the outside world. */
export interface SentItem {
  emailId: string;
  kind: "reply" | "new_email" | "invite";
  summary: string;
}

export interface AssistantState {
  emails: InboxEmail[];
  /** The thread being worked, or `null` between emails. */
  openId: string | null;
  /** Their pending interrupt — at most one, which `propose` in `review.ts` enforces. */
  proposal: Proposal | null;
  /**
   * Their per-thread `messages`, as prose lines: what was drafted, what the
   * meeting assistant found, what the executive said. The reflection graphs
   * read it as the trajectory; `open_email` resets it.
   */
  exchange: string[];
  memory: Memory;
  /** Their `triage_examples` namespace. */
  triageExamples: TriageExample[];
  reflections: Reflection[];
  sent: SentItem[];
  /** What has happened on this call, for the sidebar. */
  log: string[];
}

export function seedAssistant(): AssistantState {
  return {
    emails: INBOX.map((email) => ({ ...email, triage: null, status: "untriaged", closedAs: null })),
    openId: null,
    proposal: null,
    exchange: [],
    memory: { ...DEFAULT_MEMORY },
    triageExamples: [],
    reflections: [],
    sent: [],
    log: [],
  };
}

/**
 * The growth bounds, as one table.
 *
 * Every one of these lists rides in a `syncState` frame or a prompt, and a
 * `note()` wrapper around `pushCapped` used to bound two of them — `log` and
 * `exchange` — while `reflections`, `sent` and `triageExamples` were pushed to
 * directly and grew for the length of the call. A cap on the slot holds
 * whatever path wrote. `SlotCaps` is what says these five keys are the ARRAYS
 * of {@link AssistantState}: a bound named for a field that is not one, or is
 * not there at all, stops compiling here rather than silently capping nothing.
 */
const CAPS: SlotCaps<AssistantState> = {
  log: 40,
  exchange: 30,
  reflections: 20,
  sent: 40,
  triageExamples: 40,
};

/**
 * The call's state, as one typed slot.
 *
 * `after` holds the one invariant nothing else should have to remember: a
 * closed email is never the open one, so a tool that closed the thread cannot
 * leave `openId` pointing at it.
 */
export const assistantSlot = sessionSlot("assistant", seedAssistant, {
  after: (state) => {
    const open = state.openId ? findEmail(state.emails, state.openId) : undefined;
    if (!open || open.status === "closed") {
      state.openId = null;
      state.proposal = null;
    }
  },
  caps: CAPS,
});

/**
 * The state as a READ hands it out: deep-frozen, and typed to say so. A mutable
 * value still satisfies it, so every `update` draft passes unchanged, while a
 * helper that WOULD have mutated stops compiling instead of throwing.
 */
export type FrozenAssistantState = DeepReadonly<AssistantState>;

export function openEmail(state: FrozenAssistantState): DeepReadonly<InboxEmail> | undefined {
  return state.openId ? findEmail(state.emails, state.openId) : undefined;
}

/** Their `get_trajectory_clean`, over the exchange. */
export function trajectoryOf(state: FrozenAssistantState): string {
  return state.exchange.length === 0 ? "(nothing yet)" : state.exchange.join("\n");
}

/**
 * The next email the executive should hear about: replies before heads-ups,
 * oldest first within each — their cron works a thread at a time, and a caller
 * wants the ones that need them first.
 */
export function nextToOpen(state: FrozenAssistantState): DeepReadonly<InboxEmail> | undefined {
  const rank = (email: DeepReadonly<InboxEmail>) => (email.triage?.response === "notify" ? 1 : 0);
  return state.emails
    .filter((email) => email.status === "queued")
    .toSorted((a, b) => rank(a) - rank(b) || a.sentAt.localeCompare(b.sentAt))[0];
}

/** Close a thread — their `mark_as_read`, with the reason kept for the sidebar. */
export function closeEmail(state: AssistantState, id: string, closedAs: ClosedAs): void {
  const email = findEmail(state.emails, id);
  if (!email) return;
  email.status = "closed";
  email.closedAs = closedAs;
}

/**
 * Their `save_email`: remember how this thread was settled, once per email, so
 * the next triage sees it as a worked example. `no` when it was ignored, `email`
 * when the executive engaged with it — exactly the two values theirs stores.
 */
export function rememberExample(
  state: AssistantState,
  email: DeepReadonly<InboxEmail>,
  result: TriageExample["result"],
): void {
  if (state.triageExamples.some((eg) => eg.emailId === email.id)) return;
  state.triageExamples.push({
    emailId: email.id,
    subject: email.subject,
    from: email.from,
    excerpt: email.body.slice(0, 400),
    result,
  });
}

const tokensOf = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);

/**
 * The token set for a stored example, memoized against the example itself.
 *
 * `triage_inbox` calls {@link similarExamples} once per pending email and only
 * the TARGET differs between those calls, so re-tokenizing every stored example
 * each time did the work N times over — with the shipped inbox and the 40-example
 * cap, 320 regex-and-Set passes instead of 40, synchronously on the guest's one
 * thread, in the tool the prompt says to call FIRST on every call. Keyed by the
 * example object so a dropped example is collected with it.
 */
const EXAMPLE_TOKENS = new WeakMap<object, Set<string>>();

function exampleTokens(eg: TriageExample): Set<string> {
  const cached = EXAMPLE_TOKENS.get(eg);
  if (cached) return cached;
  const built = tokensOf(`${eg.from} ${eg.subject} ${eg.excerpt}`);
  EXAMPLE_TOKENS.set(eg, built);
  return built;
}

/**
 * Their `store.asearch(namespace, query=str(email), limit=5)` — nearest examples
 * by a token overlap over sender, subject and body. A vector index is what the
 * store gives them; a template ships none, and over a session's handful of
 * examples an overlap count picks the same neighbours.
 */
export function similarExamples(
  examples: readonly TriageExample[],
  email: { from: string; subject: string; body: string },
  limit = 5,
): TriageExample[] {
  const target = tokensOf(`${email.from} ${email.subject} ${email.body}`);
  const score = (eg: TriageExample) => {
    let overlap = 0;
    for (const token of exampleTokens(eg)) {
      if (target.has(token)) overlap += 1;
    }
    return overlap;
  };
  return examples
    .map((eg) => ({ eg, score: score(eg) }))
    .toSorted((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ eg }) => eg);
}

// ─── The review dialog ───────────────────────────────────────────────────────

/** The three positions, spelled the way `when` and `matches` address them. */
export const AT_INBOX = "onCall.inbox";
export const DRAFTING = "onCall.drafting";
export const AWAITING = "onCall.awaitingDecision";

/**
 * The hang-up, as the runtime delivers it.
 *
 * An `@`-prefixed key is a SESSION event rather than one a tool sends, and it
 * is a plain string in the spec — so a misspelling declares a transition
 * nothing will ever take, silently, and the gate this template exists for stays
 * open after the caller is gone. `satisfies` is what makes the spelling a
 * compile error: `SessionEventType` is the union of what the runtime actually
 * delivers, and the literal type survives it, which the `as const` below needs.
 */
const HUNG_UP = "@session.timed-out" satisfies `@${SessionEventType}`;

/**
 * `as const` is load-bearing: the event union is synthesized from the `on` keys.
 *
 * The hang-up is declared ONCE, on the parent (see `roadside-assist`), and it
 * matters more here than in most templates: an executive who hangs up with a
 * draft waiting would otherwise leave `accept` legal for the rest of the
 * session, and `accept` is the one tool that sends email in their name.
 */
const reviewSpec = {
  initial: "onCall",
  states: {
    onCall: {
      initial: "inbox",
      on: { [HUNG_UP]: "abandoned" },
      states: {
        inbox: {
          instruction:
            "No email is open. Triage with triage_inbox if you have not, then open the next " +
            "one with open_email. Say what is in the inbox before you open anything.",
          on: { OPENED: "drafting", NOTIFY: "awaitingDecision" },
        },
        drafting: {
          instruction:
            "An email is open and the brief from open_email says how to handle it. Choose " +
            "ONE tool — draft_reply, ask_question, meeting_assistant, send_calendar_invite, " +
            "new_email or ignore — and do not describe a draft you have not staged.",
          on: { PROPOSED: "awaitingDecision", SETTLED: "inbox" },
        },
        awaitingDecision: {
          instruction:
            "Something is waiting on the executive's word. Read it back and hear their " +
            "answer, then call exactly one of accept, edit, ignore or respond. Nothing is " +
            "sent until accept has run.",
          // Reading a draft back is transcription, not composition.
          temperature: 0.2,
          on: { SETTLED: "inbox", REDRAFT: "drafting" },
        },
      },
    },
    abandoned: {
      final: true,
      instruction:
        "The executive is gone. Do nothing further — do not send, do not ignore, do not " +
        "promise anything.",
    },
  },
} as const;

/**
 * Where the review is, on its own slot beside {@link assistantSlot}.
 *
 * The flow holds the POSITION and the slot holds the proposal itself, because an
 * inspectable {@link Proposal} is what `accept` re-derives the effect from. One
 * tool call always moves both: a drafting tool writes `proposal` and sends
 * `PROPOSED` in the same call, and a settling tool clears it and sends
 * `SETTLED` or `REDRAFT` — so the position and the payload cannot disagree.
 */
export const reviewFlow = dialog("review", reviewSpec);

// ─── The projection ──────────────────────────────────────────────────────────

export interface AssistantView {
  phase: "inbox" | "drafting" | "awaitingDecision";
  open: { id: string; from: string; subject: string; body: string; triage: Triage | null } | null;
  proposal: {
    kind: ProposalKind;
    title: string;
    body: string;
    allowed: readonly HumanResponse[];
  } | null;
  emails: readonly {
    id: string;
    from: string;
    subject: string;
    triage: Triage | null;
    status: InboxEmail["status"];
    closedAs: ClosedAs | null;
  }[];
  memory: Memory;
  reflections: readonly Reflection[];
  sent: readonly SentItem[];
  log: readonly string[];
}

/**
 * What the browser sees — the Agent Inbox, rendered. The triage examples stay
 * server-side (they are a prompt, not a display), and the proposal goes out as
 * PROSE rather than as a union the client would have to re-switch on.
 */
export function assistantView(state: FrozenAssistantState): AssistantView {
  const open = openEmail(state);
  return {
    phase: state.proposal ? "awaitingDecision" : open ? "drafting" : "inbox",
    open: open
      ? {
          id: open.id,
          from: open.from,
          subject: open.subject,
          body: open.body,
          triage: open.triage?.response ?? null,
        }
      : null,
    proposal: state.proposal
      ? {
          kind: state.proposal.kind,
          ...describeProposal(state.proposal),
          allowed: ALLOWED[state.proposal.kind],
        }
      : null,
    emails: state.emails.map((email) => ({
      id: email.id,
      from: email.from,
      subject: email.subject,
      triage: email.triage?.response ?? null,
      status: email.status,
      closedAs: email.closedAs,
    })),
    memory: state.memory,
    reflections: state.reflections,
    sent: state.sent,
    log: state.log,
  };
}

/** The projection BOTH ends use: `syncState` on the agent, `useAgentState` in the client. */
export const assistantProjection = assistantSlot.projection(assistantView);
