import "@alexkroman1/aai-ui/styles.css";
import { AutoScroll, mountClient, useAgentState } from "@alexkroman1/aai-ui";
import { planProjection } from "./shared.ts";

/**
 * The plan, ticking off.
 *
 * A plan is the one thing in this template that is genuinely hard to hold by
 * ear — four steps, two of them done, one rewritten since it was first read
 * out. The sidebar is where that lives; the call is where the decisions happen.
 */
function PlanSidebar() {
  const plan = useAgentState(planProjection);

  if (!plan.objective) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <span className="text-4xl">🗂️</span>
        <p className="text-sm opacity-60 text-aai-text">
          Say what you want to get done and the plan appears here.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4 text-aai-text">
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-bold uppercase tracking-wide opacity-60">Objective</h3>
        <p className="text-sm">{plan.objective}</p>
        <div className="h-1.5 w-full rounded-full bg-aai-surface">
          {/* The WIDTH is the one thing here that is genuinely computed, so it
              stays inline; the colour is a token. */}
          <div
            className="h-1.5 rounded-full transition-all bg-aai-primary"
            style={{ width: `${Math.round(plan.progress * 100)}%` }}
          />
        </div>
        <p className="text-xs opacity-50">
          {plan.done.length} done · {plan.plan.length} to go
        </p>
      </div>

      <AutoScroll
        scrollClassName="min-h-0 overflow-y-auto"
        contentClassName="flex flex-col gap-2 pr-1"
      >
        {plan.done.map((past) => (
          <div key={past.step} className="rounded-lg p-3 bg-aai-surface">
            <p className="text-sm">
              <span className="text-aai-primary">✓</span> {past.step}
            </p>
            <p className="mt-1 text-xs opacity-70">{past.result}</p>
            {past.searches.length > 0 && (
              <p className="mt-1 text-[11px] opacity-40">searched: {past.searches.join(" · ")}</p>
            )}
          </div>
        ))}
        {plan.plan.map((step, index) => (
          // Steps are short spoken sentences and can legitimately repeat across
          // a revision, so the position is part of the identity.
          <div
            key={`${index}-${step}`}
            className="rounded-lg p-3 text-sm opacity-60 border border-dashed border-aai-border"
          >
            <span className="opacity-50">{plan.done.length + index + 1}.</span> {step}
          </div>
        ))}
      </AutoScroll>

      {plan.response && (
        <div className="rounded-lg p-3 bg-aai-surface border border-aai-primary">
          <p className="text-[11px] font-bold uppercase tracking-wide opacity-60">Answer</p>
          <p className="mt-1 text-sm">{plan.response}</p>
        </div>
      )}

      {plan.revisions.length > 0 && (
        <details className="text-xs opacity-60">
          <summary className="cursor-pointer">Plan history ({plan.revisions.length})</summary>
          <div className="mt-1 flex flex-col gap-1">
            {plan.revisions.map((entry, index) => (
              // Append-only and capped, so the index is stable for its lifetime.
              <p key={`${index}-${entry}`}>{entry}</p>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

mountClient({
  name: "Planning Desk",
  sidebar: PlanSidebar,
  theme: {
    bg: "#12100e",
    primary: "#d9a441",
    text: "#f3efe7",
    surface: "#1e1a16",
    border: "#2c2620",
  },
  tools: {
    start_plan: { icon: "\u{1F5C2}", label: "Drafting the plan" },
    work_next_step: { icon: "\u{1F50E}", label: "Working a step" },
    revise_plan: { icon: "\u{270F}", label: "Revising the plan" },
    plan_status: { icon: "\u{2139}", label: "Checking the plan" },
  },
});
