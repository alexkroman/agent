import { formatMoney, plural } from "@alexkroman1/aai/utils";
import "@alexkroman1/aai-ui/styles.css";
import type {
  AgentState,
  ChatMessage,
  SessionControlButton,
  ToolCallInfo,
} from "@alexkroman1/aai-ui";
import {
  ConversationView,
  mountClient,
  SessionControls,
  SessionErrorBanner,
  SessionStateDot,
  ToolCallRow,
  useAgentState,
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

/*
 * The desk's own motion is the slide-in alone; the pulse it declared beside it
 * was the SDK's `aai-pulse` under another name. Scrollbars are `.aai-scroll`
 * from the same stylesheet, told the thumb colour through a custom property.
 */
const CSS = `
@keyframes rt-slide-in { from { transform: translateY(8px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
.rt-main { --aai-scrollbar-thumb: #d4d4d8; }
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
// states in its own colours, so it is the one prop `<SessionStateDot>` cannot
// default. What the SDK does own is `AgentState`, and `satisfies
// Record<AgentState, string>` is what borrows it: a state added there stops
// compiling here, where the `state === "…"` chain this replaced answered a new
// state with a silent grey badge in three separate files and no way to notice.
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
        <span style={{ animation: "aai-pulse 1.4s ease-in-out infinite" }}>●</span>
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

/**
 * The tool the agent ran: the SDK's compact row with the desk's own dot in its
 * icon slot. `ToolCallRow` owns the shimmer while the call is pending and the
 * row's shape; the dot's colours are this desk's.
 */
function ToolChip({ toolCall }: { toolCall: ToolCallInfo }) {
  const pending = toolCall.status === "pending";
  return (
    <ToolCallRow
      variant="compact"
      className="self-start"
      title={toolCall.name}
      pending={pending}
      icon={
        <span
          className="w-1.5 h-1.5 rounded-full inline-block align-middle"
          style={{
            background: pending ? "#ca8a04" : "#16a34a",
            animation: pending ? "aai-pulse 1s ease-in-out infinite" : "none",
          }}
        />
      }
    />
  );
}

/** One line of the call — the markup this template is for. */
function Bubble({ role, content }: ChatMessage) {
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
 * `<ConversationView>` rather than `session.messages.map(...)`. The messages
 * were only part of it: this agent runs FIFTEEN tools and the operator could
 * see none of them, because tool calls live in a second array this page never
 * read — and the streaming reply and the thinking indicator were dropped along
 * with them. The view owns the interleave (a tool row follows the message it
 * was anchored to), the `null`-vs-`""` transcript distinction, the
 * thinking-suppression rule and the announced thinking row; the markup in each
 * slot is what this template is for. The live transcript is the strip pinned
 * BELOW the scroll, which is `transcriptPosition="below"`.
 *
 * It subscribes per FIELD, so the customer file in the sidebar no longer
 * re-renders on every partial transcript the way the whole-page `useSession()`
 * this replaced made it.
 */
function Conversation() {
  return (
    <ConversationView
      scrollClassName="aai-scroll overflow-y-auto"
      contentClassName="p-4 flex flex-col gap-2"
      empty={
        <div className="text-center p-10 text-[13px]" style={{ color: "#a1a1aa" }}>
          Press start, then read one of the emails from “Who to be” to the agent.
        </div>
      }
      renderMessage={(message) => <Bubble {...message} />}
      renderTool={(toolCall) => <ToolChip toolCall={toolCall} />}
      renderTranscript={({ text }) => (
        <div
          className="flex items-center px-4 py-2 text-xs italic min-h-8"
          style={{ background: "#fafafa", borderTop: "1px solid #e4e4e7", color: "#71717a" }}
        >
          <span
            className="w-2 h-2 rounded-full inline-block mr-2"
            style={{ background: "#16a34a", animation: "aai-pulse 1.5s ease-in-out infinite" }}
          />
          {text}
        </div>
      )}
      transcriptPosition="below"
      thinkingLabel="Agent is thinking"
      thinkingClassName="self-start text-[11px] px-3.5 text-[#a1a1aa]"
    />
  );
}

/** The live status dot, on its own subscription rather than a field off a
 *  whole-page read — the header is the only thing here that wants it. No
 *  `labels`: the package's word for each state is the right one here, where a
 *  caller of this desk used to read a lowercase `disconnected` in the header. */
function StatusReadout() {
  return (
    <SessionStateDot
      colors={STATE_COLORS}
      labelClassName="text-[11px] font-normal text-[#a1a1aa]"
    />
  );
}

const CALL_BUTTON = "px-4 py-2 rounded-md text-xs font-semibold cursor-pointer";

/**
 * One call button in the desk's colours. `<SessionControls>` decides WHICH
 * buttons exist and what each presses — including that "New Conversation" is
 * `end()` then `start()` and never `reset()`, argued once on that component;
 * this decides only how they look.
 */
function callButton({ action, label, onClick, running }: SessionControlButton) {
  const look =
    action === "end"
      ? { background: "#dc2626", color: "#ffffff", border: "none" }
      : action === "restart"
        ? { background: "#ffffff", color: "#18181b", border: "1px solid #e4e4e7" }
        : action === "toggle" && running
          ? { background: "#e4e4e7", color: "#18181b", border: "none" }
          : { background: "#2563eb", color: "#ffffff", border: "none" };
  return (
    <button type="button" className={CALL_BUTTON} style={look} onClick={onClick}>
      {label}
    </button>
  );
}

/**
 * The call controls: Start call, then Hold/Resume, New Conversation and End.
 * Two one-field subscriptions through `useSessionControls`, so the row
 * re-renders when a flag flips and not on every STT partial the way the
 * whole-snapshot `useSession()` it replaced did.
 */
function CallControls({ productCount }: { productCount: number }) {
  return (
    <SessionControls
      className="px-4 py-3 bg-white border-t border-[#e4e4e7]"
      labels={{ start: "Start call", pause: "Hold" }}
      renderButton={callButton}
    >
      <div className="flex-1" />
      <span className="text-[10px] tabular-nums" style={{ color: "#a1a1aa" }}>
        {productCount} products
      </span>
    </SessionControls>
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
            className="aai-scroll overflow-y-auto p-3 flex flex-col gap-3"
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
