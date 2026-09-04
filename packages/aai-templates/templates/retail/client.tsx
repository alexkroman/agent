import { formatMoney, plural } from "@alexkroman1/aai/utils";
import "@alexkroman1/aai-ui/styles.css";
import type { AgentState, ConversationItem } from "@alexkroman1/aai-ui";
import {
  AutoScroll,
  mountClient,
  SessionErrorBanner,
  useAgentState,
  useConversation,
  useSessionActions,
  useSessionSelector,
  useSessionStatus,
} from "@alexkroman1/aai-ui";
import type { ReactNode } from "react";
import type {
  OrderStatus,
  OrderView,
  PaymentMethodView,
  PendingView,
  StoreView,
  SwapOptionView,
} from "./shared.ts";
import { DEMO_PERSONAS, emptyRetailState, storeView } from "./shared.ts";

const CSS = `
@keyframes rt-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
@keyframes rt-slide-in { from { transform: translateY(8px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
.rt-scroll::-webkit-scrollbar { width: 6px; }
.rt-scroll::-webkit-scrollbar-track { background: transparent; }
.rt-scroll::-webkit-scrollbar-thumb { background: #d4d4d8; border-radius: 3px; }
@media (max-width: 900px) {
  /* Both rows bounded: an auto row sizes to the sidebar's full content, which
     would push the chat (and its Hold/End controls) past the viewport. */
  .rt-main { grid-template-columns: 1fr !important; grid-template-rows: minmax(0, 1fr) minmax(0, 40%) !important; }
}
`;

// `satisfies`-pinned to the shared union, so a new order status is a compile
// error here rather than a silently grey badge.
const statusColors: Record<string, string> = {
  pending: "#b45309",
  "pending (item modified)": "#7c3aed",
  processed: "#0369a1",
  delivered: "#15803d",
  cancelled: "#71717a",
  "return requested": "#c2410c",
  "exchange requested": "#a16207",
} satisfies Record<OrderStatus, string>;

// The sidebar before the first tool call, derived from the projection itself so
// a new StoreView field can't miss the pre-first-call render.
//
// **This is the one template that does NOT pass its projection to
// `useAgentState`**, and the reason is the browser bundle rather than style:
// that overload derives the empty frame by calling the projection, which calls
// the slot's `create()` — and this slot's factory lives in `store.ts` and pulls
// the 107 KB seed, so importing it here would ship the whole catalog to the
// browser. `emptyRetailState()` is the same shape without the seed. Reach for
// the projection overload everywhere the factory is cheap, which is every
// other stateful template.
const EMPTY_VIEW: StoreView = storeView(emptyRetailState());

// The dot's colour per session state, as an EXHAUSTIVE map rather than an
// if-chain with a grey default.
//
// The palette is this template's own — every client here paints the same six
// states in its own colours, so the SDK has nothing to share but the union. What
// the SDK does own is `AgentState`, and `satisfies Record<AgentState, string>`
// is what borrows it: a state added there stops compiling here, where the
// `state === "…"` chain this replaced answered a new state with a silent grey
// badge in three separate files and no way to notice.
const STATE_COLORS = {
  disconnected: "#a1a1aa",
  connecting: "#a1a1aa",
  ready: "#16a34a",
  listening: "#16a34a",
  thinking: "#ca8a04",
  speaking: "#2563eb",
  error: "#a1a1aa",
} satisfies Record<AgentState, string>;

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg p-3" style={{ background: "#ffffff", border: "1px solid #e4e4e7" }}>
      <div
        className="text-[10px] font-semibold uppercase tracking-[1.3px] mb-2"
        style={{ color: "#71717a" }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function MethodRow({ method }: { method: PaymentMethodView }) {
  return (
    <div className="flex justify-between items-center py-0.5 text-xs">
      <span style={{ color: "#52525b" }}>{method.label}</span>
      {method.balance === undefined ? (
        <span className="text-[10px] uppercase tracking-wider" style={{ color: "#a1a1aa" }}>
          on file
        </span>
      ) : (
        <span className="font-semibold tabular-nums" style={{ color: "#15803d" }}>
          {formatMoney(method.balance)}
        </span>
      )}
    </div>
  );
}

function OrderCard({ order, focused }: { order: OrderView; focused: boolean }) {
  const color = statusColors[order.status] ?? "#71717a";
  return (
    <div
      className="rounded-md p-2.5 mb-2"
      style={{
        background: focused ? "#fafafa" : "#ffffff",
        animation: "rt-slide-in 0.25s ease-out",
        border: `1px solid ${focused ? color : "#e4e4e7"}`,
        borderLeft: `3px solid ${color}`,
        boxShadow: focused ? `0 0 0 2px ${color}22` : "none",
      }}
    >
      <div className="flex justify-between items-center gap-2 mb-1">
        <span className="text-xs font-semibold tabular-nums" style={{ color: "#18181b" }}>
          {order.orderId}
        </span>
        <span
          className="text-[9px] px-1.5 py-0.5 rounded font-semibold uppercase whitespace-nowrap"
          style={{ background: `${color}1a`, color }}
        >
          {order.status}
        </span>
      </div>
      <div className="text-[11px] mb-1 tabular-nums" style={{ color: "#71717a" }}>
        {formatMoney(order.total)} · {order.items.length} {plural(order.items.length, "item")}
      </div>
      {order.items.slice(0, 3).map((item) => (
        <div
          key={`${item.itemId}-${item.name}`}
          className="text-[11px]"
          style={{ color: "#52525b" }}
        >
          · {item.name}{" "}
          <span style={{ color: "#a1a1aa" }}>{Object.values(item.options).join(", ")}</span>
        </div>
      ))}
      {order.items.length > 3 && (
        <div className="text-[11px]" style={{ color: "#a1a1aa" }}>
          · and {order.items.length - 3} more
        </div>
      )}
    </div>
  );
}

/** Character select. Rendered before authentication, because a user with no
 *  email to give cannot start the conversation at all. */
/**
 * The change waiting on the caller's word.
 *
 * The one panel that renders BECAUSE nothing has happened. A staged change is
 * the agent's promise about what it is going to do, so showing it beside the
 * orders it has not touched is what lets a watcher catch a readback that does
 * not match the request — which is the failure the whole gate is aimed at, and
 * the one nobody can see from a transcript alone.
 */
function PendingChange({ pending }: { pending: PendingView }) {
  return (
    <div
      className="rounded-lg p-3"
      style={{
        background: "#fffbeb",
        border: "1px solid #fcd34d",
        animation: "rt-slide-in 180ms ease-out",
      }}
    >
      <div
        className="text-[10px] font-semibold uppercase tracking-wider mb-1.5 flex items-center gap-1.5"
        style={{ color: "#b45309" }}
      >
        <span style={{ animation: "rt-pulse 1.4s ease-in-out infinite" }}>●</span>
        Awaiting the caller's yes
      </div>
      <div className="text-xs leading-relaxed" style={{ color: "#78350f" }}>
        {pending.readBack}
      </div>
      <div className="text-[10px] mt-1.5" style={{ color: "#a16207" }}>
        Nothing has changed yet — {pending.kind}
      </div>
    </div>
  );
}

function PersonaList() {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[11px] leading-snug" style={{ color: "#3f3f46" }}>
        Pick someone to be, then read their email to the agent.
      </div>
      {DEMO_PERSONAS.map((persona) => (
        <div
          key={persona.email}
          className="rounded-md p-2"
          style={{ background: "#ffffff", border: "1px solid #e4e4e7" }}
        >
          <div className="text-xs font-semibold" style={{ color: "#18181b" }}>
            {persona.name}
          </div>
          <div className="text-[11px] break-all" style={{ color: "#2563eb" }}>
            {persona.email}
          </div>
          <div className="text-[10px] tabular-nums" style={{ color: "#a1a1aa" }}>
            zip {persona.zip}
          </div>
          <div className="text-[10px] leading-snug mt-1" style={{ color: "#71717a" }}>
            {persona.hint}
          </div>
        </div>
      ))}
    </div>
  );
}

/** What the focused order's items could become — the words a user needs in order
 *  to ask for an exchange or an item change. */
function SwapOptions({ option }: { option: SwapOptionView }) {
  return (
    <div className="mb-2.5">
      <div className="text-[11px] font-semibold" style={{ color: "#18181b" }}>
        {option.itemName}
      </div>
      <div className="text-[10px] mb-1" style={{ color: "#a1a1aa" }}>
        now: {Object.values(option.currentOptions).join(", ")}
      </div>
      {option.alternatives.length === 0 ? (
        <div className="text-[10px]" style={{ color: "#a1a1aa" }}>
          No other option is in stock.
        </div>
      ) : (
        option.alternatives.map((alternative) => (
          <div
            key={alternative.itemId}
            className="flex justify-between gap-2 text-[10px] py-0.5"
            style={{ color: "#52525b" }}
          >
            <span>{Object.values(alternative.options).join(", ")}</span>
            <span className="tabular-nums whitespace-nowrap" style={{ color: "#71717a" }}>
              {formatMoney(alternative.price)}
            </span>
          </div>
        ))
      )}
    </div>
  );
}

/** One line of the call: a bubble, or the tool the agent ran after it. */
function Row({ item }: { item: ConversationItem }) {
  if (item.kind === "tool") {
    const { name, status } = item.toolCall;
    return (
      <div
        className="self-start rounded-md px-2.5 py-1 text-[11px] font-mono flex items-center gap-2"
        style={{
          background: "#ffffff",
          border: "1px solid #e4e4e7",
          color: status === "pending" ? "#b45309" : "#71717a",
        }}
      >
        <span
          className="w-1.5 h-1.5 rounded-full inline-block"
          style={{
            background: status === "pending" ? "#ca8a04" : "#16a34a",
            animation: status === "pending" ? "rt-pulse 1s ease-in-out infinite" : "none",
          }}
        />
        {name}
      </div>
    );
  }
  const { role, content } = item.message;
  return (
    <div
      className="rounded-lg text-[13px] max-w-[80%] px-3.5 py-2.5"
      style={{
        lineHeight: 1.55,
        alignSelf: role === "assistant" ? "flex-start" : "flex-end",
        background: role === "assistant" ? "#ffffff" : "#2563eb",
        color: role === "assistant" ? "#18181b" : "#ffffff",
        border: role === "assistant" ? "1px solid #e4e4e7" : "none",
        animation: "rt-slide-in 0.2s ease-out",
      }}
    >
      {content}
    </div>
  );
}

/**
 * The call transcript.
 *
 * `useConversation()` rather than `session.messages.map(...)`. The messages
 * were only part of it: this agent runs FIFTEEN tools and the operator could
 * see none of them, because tool calls live in a second array this page never
 * read — and the streaming reply and the thinking indicator were dropped along
 * with them. The hook owns the interleave (a tool row follows the message it
 * was anchored to), the `null`-vs-`""` transcript distinction and the
 * thinking-suppression rule; the markup below is what this template is for.
 *
 * It subscribes per FIELD, so the customer file in the sidebar no longer
 * re-renders on every partial transcript the way the whole-page `useSession()`
 * this replaced made it.
 */
function Conversation() {
  const { items, streaming, transcript, thinking } = useConversation();
  return (
    <>
      <AutoScroll
        scrollClassName="rt-scroll overflow-y-auto"
        contentClassName="p-4 flex flex-col gap-2"
      >
        {items.length === 0 && streaming === null && (
          <div className="text-center p-10 text-[13px]" style={{ color: "#a1a1aa" }}>
            Press start, then read one of the emails from “Who to be” to the agent.
          </div>
        )}
        {items.map((item) => (
          <Row
            key={item.kind === "message" ? `m${item.message.id}` : item.toolCall.callId}
            item={item}
          />
        ))}
        {streaming !== null && (
          <div
            className="rounded-lg text-[13px] max-w-[80%] px-3.5 py-2.5 self-start"
            style={{
              lineHeight: 1.55,
              background: "#ffffff",
              color: "#18181b",
              border: "1px solid #e4e4e7",
            }}
          >
            {streaming}
          </div>
        )}
        {/* Same contract as the shipped `MessageList`'s indicator: three pulsing
            dots are the only sign the agent is working, and to a screen reader
            they are punctuation. */}
        {thinking && (
          <div
            role="status"
            aria-label="Agent is thinking"
            className="self-start text-[11px] px-3.5"
            style={{ color: "#a1a1aa" }}
          >
            <span style={{ animation: "rt-pulse 1.2s ease-in-out infinite" }}>· · ·</span>
          </div>
        )}
      </AutoScroll>

      {transcript.speaking && (
        <div
          className="flex items-center px-4 py-2 text-xs italic min-h-8"
          style={{ background: "#fafafa", borderTop: "1px solid #e4e4e7", color: "#71717a" }}
        >
          <span
            className="w-2 h-2 rounded-full inline-block mr-2"
            style={{ background: "#16a34a", animation: "rt-pulse 1.5s ease-in-out infinite" }}
          />
          {transcript.text}
        </div>
      )}
    </>
  );
}

/** The live status dot, on its own subscription rather than a field off a
 *  whole-page read — the header is the only thing here that wants it. */
function StatusReadout() {
  const state = useSessionStatus();
  return (
    <>
      <span
        className="w-2 h-2 rounded-full inline-block"
        style={{
          background: STATE_COLORS[state],
          animation:
            state === "listening"
              ? "rt-pulse 1.5s ease-in-out infinite"
              : state === "thinking"
                ? "rt-pulse 0.8s ease-in-out infinite"
                : "none",
        }}
        title={state}
      />
      <span className="text-[11px] font-normal" style={{ color: "#a1a1aa" }}>
        {state}
      </span>
    </>
  );
}

/*
 * The call controls.
 *
 * The methods come off `useSessionActions()`, which does not subscribe, and the
 * two flags off one-field selectors. The whole-snapshot `useSession()` this
 * replaced re-rendered these four buttons on every STT partial to read two
 * booleans that change once a call.
 */
function CallControls({ productCount }: { productCount: number }) {
  const { start, toggle, restart, end } = useSessionActions();
  const started = useSessionSelector((s) => s.started);
  const running = useSessionSelector((s) => s.running);
  return (
    <div
      className="flex items-center gap-2 px-4 py-3"
      style={{ background: "#ffffff", borderTop: "1px solid #e4e4e7" }}
    >
      {!started ? (
        <button
          type="button"
          className="px-4 py-2 border-none rounded-md text-xs font-semibold cursor-pointer text-white"
          style={{ background: "#2563eb" }}
          onClick={() => start()}
        >
          Start call
        </button>
      ) : (
        <>
          <button
            type="button"
            className="px-4 py-2 border-none rounded-md text-xs font-semibold cursor-pointer"
            style={{
              background: running ? "#e4e4e7" : "#2563eb",
              color: running ? "#18181b" : "#ffffff",
            }}
            onClick={() => toggle()}
          >
            {running ? "Hold" : "Resume"}
          </button>
          {/* The one-click new conversation the default shell's
              `<Controls>` gives every other template — a custom
              `component:` renders no `<Controls>`, so a console like
              this one has to say it itself. end() then start(), so the
              redial is a brand-new session (fresh store, greeting
              included) and the console stays on the call rather than
              dropping back to "Start call". */}
          <button
            type="button"
            className="px-4 py-2 rounded-md text-xs font-semibold cursor-pointer"
            style={{ background: "#ffffff", color: "#18181b", border: "1px solid #e4e4e7" }}
            onClick={restart}
          >
            New Conversation
          </button>
          {/* end() hangs up and flips `started` back, so the UI
              returns to "Start call" and the next start is a brand-new
              session (fresh store, greeting included). reset() would
              keep the call live — the buttons never toggle back. */}
          <button
            type="button"
            className="px-4 py-2 border-none rounded-md text-xs font-semibold cursor-pointer text-white"
            style={{ background: "#dc2626" }}
            onClick={() => end()}
          >
            End
          </button>
        </>
      )}
      <div className="flex-1" />
      <span className="text-[10px] tabular-nums" style={{ color: "#a1a1aa" }}>
        {productCount} products
      </span>
    </div>
  );
}

function App() {
  // The agent's own store, projected by `syncState` after every tool call —
  // the only subscription at this level now. The session reads that used to sit
  // beside it moved into the four components above, so a partial transcript no
  // longer re-renders the customer file.
  const view = useAgentState<StoreView>(EMPTY_VIEW);

  const lastAction = view.activity.at(-1);

  return (
    <>
      <style>{CSS}</style>
      <div
        className="flex flex-col h-dvh overflow-hidden m-0 p-0"
        style={{ background: "#f4f4f5", color: "#18181b" }}
      >
        <div
          className="flex items-center justify-between px-5 py-3 gap-4 flex-wrap shrink-0"
          style={{ background: "#ffffff", borderBottom: "1px solid #e4e4e7" }}
        >
          <div className="flex items-center gap-2.5 text-base font-semibold">
            <span style={{ color: "#2563eb" }}>◆</span>
            Retail Support
            <StatusReadout />
          </div>
          <span
            className="px-2.5 py-1 rounded text-[10px] font-semibold uppercase tracking-wider"
            style={
              view.customer
                ? { background: "#dcfce7", color: "#15803d" }
                : { background: "#f4f4f5", color: "#71717a" }
            }
          >
            {view.customer ? `Verified · ${view.customer.name}` : "Not yet identified"}
          </span>
        </div>

        <div
          className="rt-main flex-1 grid overflow-hidden"
          style={{ gridTemplateColumns: "1fr 340px" }}
        >
          {/* Conversation */}
          <div
            className="flex flex-col overflow-hidden"
            style={{ borderRight: "1px solid #e4e4e7" }}
          >
            <Conversation />
            <SessionErrorBanner className="rounded-none border-x-0 border-b-0" />
            <CallControls productCount={view.productCount} />
          </div>

          {/* Sidebar: the customer file */}
          <div
            className="rt-scroll overflow-y-auto p-3 flex flex-col gap-3"
            style={{ background: "#f4f4f5" }}
          >
            {view.pending && <PendingChange pending={view.pending} />}

            {!view.customer && (
              <Panel title="Who to be">
                <PersonaList />
              </Panel>
            )}

            <Panel title="Customer">
              {view.customer ? (
                <>
                  <div className="text-sm font-semibold">{view.customer.name}</div>
                  <div className="text-[11px] break-all" style={{ color: "#71717a" }}>
                    {view.customer.email}
                  </div>
                  <div className="text-[11px] mt-1" style={{ color: "#71717a" }}>
                    {view.customer.address.address1}
                    {view.customer.address.address2 ? `, ${view.customer.address.address2}` : ""}
                    <br />
                    {view.customer.address.city} {view.customer.address.state}{" "}
                    {view.customer.address.zip}
                  </div>
                </>
              ) : (
                <div className="text-xs" style={{ color: "#a1a1aa" }}>
                  Nothing is looked up until the caller is identified.
                </div>
              )}
            </Panel>

            {view.customer && (
              <Panel title="Payment methods">
                {view.customer.paymentMethods.map((method) => (
                  <MethodRow key={method.id} method={method} />
                ))}
              </Panel>
            )}

            {view.orders.length > 0 && (
              <Panel title={`Orders (${view.orders.length})`}>
                {view.orders.map((order) => (
                  <OrderCard
                    key={order.orderId}
                    order={order}
                    focused={order.orderId === view.focus.orderId}
                  />
                ))}
              </Panel>
            )}

            {view.swapOptions.length > 0 && (
              <Panel title={`Swap options · ${view.focus.orderId ?? ""}`}>
                {view.swapOptions.map((option) => (
                  <SwapOptions key={option.itemId} option={option} />
                ))}
              </Panel>
            )}

            <Panel title="You can say">
              {view.scriptBullets.map((bullet) => (
                <div
                  key={bullet}
                  className="text-[11px] leading-relaxed mb-1"
                  style={{ color: "#3f3f46" }}
                >
                  · {bullet}
                </div>
              ))}
            </Panel>
          </div>
        </div>

        {/* The footer strip. `callSeq` is monotonic, so this moves on EVERY tool
            call — including a repeated read that changed nothing else. */}
        <div
          className="flex items-center justify-between px-5 py-2 text-[10px] shrink-0"
          style={{ background: "#ffffff", borderTop: "1px solid #e4e4e7", color: "#71717a" }}
        >
          <span className="truncate">
            {lastAction ? (
              <>
                <span style={{ color: "#2563eb" }}>{lastAction.tool}</span> — {lastAction.summary}
              </>
            ) : (
              "No tool calls yet"
            )}
          </span>
          <span className="tabular-nums whitespace-nowrap ml-3">
            {view.callSeq} {plural(view.callSeq, "call")}
          </span>
        </div>
      </div>
    </>
  );
}

mountClient({
  component: App,
  theme: {
    bg: "#f4f4f5",
    primary: "#2563eb",
    text: "#18181b",
    surface: "#ffffff",
    border: "#e4e4e7",
  },
});
