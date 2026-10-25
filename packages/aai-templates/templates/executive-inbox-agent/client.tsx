import "@alexkroman1/aai-ui/styles.css";
import { AutoScroll, mountClient, useAgentState } from "@alexkroman1/aai-ui";
import type { AssistantView, Triage } from "./shared.ts";
import { assistantSlot } from "./shared.ts";

/**
 * The Agent Inbox, rendered beside the call.
 *
 * EAIA's human sits in a web inbox reading a halted run's proposal and pressing
 * one of four buttons. Here the executive HEARS the proposal, so what this panel
 * earns its place with is the parts a phone cannot carry: the full text of a
 * draft the assistant just read aloud, which of the four answers this proposal
 * takes, the queue of what is still coming, and — the reason to build the
 * template at all — what the assistant has learned from the corrections so far.
 */

const PHASES: readonly { id: AssistantView["phase"]; label: string }[] = [
  { id: "inbox", label: "Inbox" },
  { id: "drafting", label: "Drafting" },
  { id: "awaitingDecision", label: "Your call" },
];

const TRIAGE_LABEL: Record<Triage, string> = {
  email: "needs a reply",
  question: "needs a reply",
  notify: "heads-up",
  no: "filed",
};

function PhaseStrip({ active }: { active: AssistantView["phase"] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {PHASES.map((phase) => {
        const on = phase.id === active;
        return (
          <span
            key={phase.id}
            className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${
              on ? "bg-aai-primary text-aai-bg" : "bg-aai-surface text-aai-text opacity-55"
            }`}
          >
            {phase.label}
          </span>
        );
      })}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[11px] font-bold uppercase tracking-wide opacity-60">{title}</p>
      {children}
    </div>
  );
}

function EmailRow({ email }: { email: AssistantView["emails"][number] }) {
  const status =
    email.status === "closed"
      ? (email.closedAs ?? "closed")
      : email.status === "open"
        ? "open"
        : email.triage
          ? TRIAGE_LABEL[email.triage]
          : "new";
  return (
    <div
      className={`flex items-center justify-between gap-3 rounded-lg p-3 bg-aai-surface ${
        email.status === "closed" ? "opacity-50" : ""
      }`}
    >
      <div className="min-w-0">
        <p className="truncate text-sm">{email.subject}</p>
        <p className="truncate text-xs opacity-60">{email.from}</p>
      </div>
      <span className="shrink-0 text-[11px] font-medium capitalize text-aai-primary">{status}</span>
    </div>
  );
}

function InboxSidebar() {
  const view = useAgentState(assistantSlot.projected);
  const queued = view.emails.filter((email) => email.status !== "closed");
  const closed = view.emails.filter((email) => email.status === "closed");

  return (
    <div className="flex flex-col gap-4 p-4 h-full min-h-0 text-aai-text">
      <PhaseStrip active={view.phase} />

      {/* The interrupt, as Agent Inbox shows it: what is proposed and which
          answers it takes. What is on screen is what was just read aloud. */}
      {view.proposal && (
        <div className="rounded-lg p-3 text-sm bg-aai-surface border border-aai-primary">
          <p className="text-[11px] font-bold uppercase tracking-wide opacity-60">
            Waiting on you · {view.proposal.title}
          </p>
          {view.proposal.body && (
            <p className="mt-1 whitespace-pre-wrap leading-relaxed">{view.proposal.body}</p>
          )}
          <p className="mt-2 text-[11px] opacity-60">Say: {view.proposal.allowed.join(" · ")}</p>
        </div>
      )}

      {view.open && (
        <Section title="Open email">
          <div className="rounded-lg p-3 bg-aai-surface">
            <p className="text-sm font-medium text-pretty">{view.open.subject}</p>
            <p className="text-xs opacity-60">{view.open.from}</p>
            <p className="mt-2 text-xs leading-relaxed opacity-80">{view.open.body}</p>
          </div>
        </Section>
      )}

      <Section title={`Inbox · ${queued.length} to go`}>
        {queued.length === 0 ? (
          <p className="text-sm opacity-50">Nothing left.</p>
        ) : (
          queued.map((email) => <EmailRow key={email.id} email={email} />)
        )}
      </Section>

      {closed.length > 0 && (
        <Section title="Done">
          {closed.map((email) => (
            <EmailRow key={email.id} email={email} />
          ))}
        </Section>
      )}

      {/* The reflection graphs' output. Every line here is a prompt the
          assistant rewrote from something the executive said on this call. */}
      <Section title="What I've learned">
        {view.reflections.length === 0 ? (
          <p className="text-xs opacity-40">Nothing yet — correct a draft and this fills in.</p>
        ) : (
          view.reflections.map((reflection, index) => (
            <p key={`${index}-${reflection.memory}`} className="text-xs leading-relaxed">
              <span className="font-medium text-aai-primary">{reflection.memory}</span>{" "}
              <span className="opacity-80">{reflection.logic}</span>
            </p>
          ))
        )}
      </Section>

      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <p className="text-[11px] font-bold uppercase tracking-wide opacity-60">Call log</p>
        <AutoScroll
          scrollClassName="overflow-y-auto min-h-0"
          contentClassName="flex flex-col gap-1 pr-1"
        >
          {view.log.length === 0 ? (
            <p className="text-xs opacity-40">Nothing yet.</p>
          ) : (
            view.log.map((entry, index) => (
              // Append-only and capped, so the index is stable for an entry's lifetime.
              <p key={`${index}-${entry}`} className="text-xs opacity-70">
                {entry}
              </p>
            ))
          )}
        </AutoScroll>
      </div>
    </div>
  );
}

mountClient({
  sidebar: InboxSidebar,
  sidebarWidth: "22rem",
  theme: { primary: "#5fb89a", mode: "dark" },
});
