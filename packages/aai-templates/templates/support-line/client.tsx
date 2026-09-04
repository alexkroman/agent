import { plural } from "@alexkroman1/aai/utils";
import "@alexkroman1/aai-ui/styles.css";
import { AutoScroll, mountClient, useAgentState } from "@alexkroman1/aai-ui";
import { PRODUCT, supportProjection } from "./shared.ts";

/**
 * The graph, as it ran for the last question.
 *
 * This is the panel worth having: the whole argument for the corrective loop is
 * work the caller never hears — four documents retrieved, three rejected, the
 * question rewritten once — and a support line whose grading is invisible is a
 * support line nobody can tell apart from one that just guesses well.
 */
function TraceSidebar() {
  const support = useAgentState(supportProjection);
  const trace = support.trace;

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4 text-aai-text">
      <div>
        <h3 className="text-sm font-bold uppercase tracking-wide opacity-60">{support.product}</h3>
        <p className="text-xs opacity-50">
          {support.asked.length} {plural(support.asked.length, "question")} this call
          {support.ticket ? ` · ticket ${support.ticket}` : ""}
        </p>
      </div>

      {!trace && (
        <p className="text-sm opacity-50">
          Ask a question and the retrieval, the grades and the verdicts appear here.
        </p>
      )}

      {trace && (
        <AutoScroll
          scrollClassName="min-h-0 overflow-y-auto"
          contentClassName="flex flex-col gap-4 pr-1"
        >
          <div className="rounded-lg p-3 bg-aai-surface">
            <p className="text-[11px] font-bold uppercase tracking-wide opacity-60">Question</p>
            <p className="text-sm">{trace.question}</p>
            {trace.rewrites > 0 && (
              <p className="mt-1 text-xs opacity-60">
                rewritten to <span className="italic">{trace.query}</span>
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <p className="text-[11px] font-bold uppercase tracking-wide opacity-60">
              Retrieved &amp; graded
            </p>
            {trace.docs.length === 0 && <p className="text-xs opacity-50">Nothing retrieved.</p>}
            {trace.docs.map((doc) => (
              <div
                key={doc.id}
                className={`flex items-start gap-2 rounded-lg p-2 bg-aai-surface ${
                  doc.relevant ? "" : "opacity-50"
                }`}
              >
                <span className={doc.relevant ? "text-aai-primary" : "text-aai-text"}>
                  {doc.relevant ? "✓" : "×"}
                </span>
                <div className="min-w-0">
                  <p className="text-sm">{doc.title}</p>
                  <p className="text-xs opacity-60">{doc.reason}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-1">
            <p className="text-[11px] font-bold uppercase tracking-wide opacity-60">Procedure</p>
            {trace.steps.map((entry, index) => (
              // Steps are append-only within a run, so the index is stable.
              <p key={`${index}-${entry.node}`} className="text-xs">
                <span className="font-mono opacity-80">{entry.node}</span>
                <span className="opacity-50"> — {entry.detail}</span>
              </p>
            ))}
          </div>

          <div className="rounded-lg p-3 bg-aai-surface">
            <p className="text-[11px] font-bold uppercase tracking-wide opacity-60">Verdict</p>
            {trace.answer ? (
              <p className="text-sm">{trace.answer}</p>
            ) : (
              <p className="text-sm opacity-60">No answer could be grounded.</p>
            )}
            <p className="mt-2 text-xs opacity-60">
              grounded: {String(trace.grounded)} · answers the question: {String(trace.useful)}
              {trace.exhausted ? " · budget exhausted" : ""}
            </p>
          </div>
        </AutoScroll>
      )}
    </div>
  );
}

mountClient({
  // Derived, not typed twice: `PRODUCT` comes off `knowledge.json`, which is
  // what `agent.ts` names the agent and greets with. A knowledge base swapped
  // for another product otherwise leaves the browser tab advertising the old
  // one.
  name: `${PRODUCT} Support`,
  sidebar: TraceSidebar,
  theme: {
    bg: "#0b1220",
    primary: "#4ea8de",
    text: "#e8eef6",
    surface: "#141d2e",
    border: "#1f2b3f",
  },
  tools: {
    answer_question: { icon: "\u{1F50D}", label: "Checking the knowledge base" },
    list_topics: { icon: "\u{1F4DA}", label: "Listing topics" },
    log_ticket: { icon: "\u{1F4DD}", label: "Logging a ticket" },
  },
});
