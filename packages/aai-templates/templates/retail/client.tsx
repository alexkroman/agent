import "@alexkroman1/aai-ui/styles.css";
import type { ChatMessage } from "@alexkroman1/aai-ui";
import { AutoScroll, client, useAgentState, useSession } from "@alexkroman1/aai-ui";
import type { ReactNode } from "react";
import type {
  OrderStatus,
  OrderView,
  PaymentMethodView,
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
// a new StoreView field can't miss the pre-first-call render. Built from
// `emptyRetailState` rather than `retailSlot.projection(...)(undefined)`,
// because the slot's factory lives in `store.ts` and pulls the 107 KB seed —
// importing it here would ship the whole catalog to the browser.
const EMPTY_VIEW: StoreView = storeView(emptyRetailState());

function stateColor(state: string): string {
  if (state === "listening" || state === "ready") return "#16a34a";
  if (state === "thinking") return "#ca8a04";
  if (state === "speaking") return "#2563eb";
  return "#a1a1aa";
}

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
          ${method.balance.toFixed(2)}
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
        ${order.total.toFixed(2)} · {order.items.length} item
        {order.items.length === 1 ? "" : "s"}
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
              ${alternative.price.toFixed(2)}
            </span>
          </div>
        ))
      )}
    </div>
  );
}

function App() {
  const session = useSession();
  // The agent's own store, projected by `syncState` after every tool call.
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
            <span
              className="w-2 h-2 rounded-full inline-block"
              style={{
                background: stateColor(session.state),
                animation:
                  session.state === "listening"
                    ? "rt-pulse 1.5s ease-in-out infinite"
                    : session.state === "thinking"
                      ? "rt-pulse 0.8s ease-in-out infinite"
                      : "none",
              }}
              title={session.state}
            />
            <span className="text-[11px] font-normal" style={{ color: "#a1a1aa" }}>
              {session.state}
            </span>
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
            <AutoScroll
              scrollClassName="rt-scroll overflow-y-auto"
              contentClassName="p-4 flex flex-col gap-2"
            >
              {session.messages.length === 0 && (
                <div className="text-center p-10 text-[13px]" style={{ color: "#a1a1aa" }}>
                  Press start, then read one of the emails from “Who to be” to the agent.
                </div>
              )}
              {session.messages.map((message: ChatMessage, index: number) => (
                <div
                  key={index}
                  className="rounded-lg text-[13px] max-w-[80%] px-3.5 py-2.5"
                  style={{
                    lineHeight: 1.55,
                    alignSelf: message.role === "assistant" ? "flex-start" : "flex-end",
                    background: message.role === "assistant" ? "#ffffff" : "#2563eb",
                    color: message.role === "assistant" ? "#18181b" : "#ffffff",
                    border: message.role === "assistant" ? "1px solid #e4e4e7" : "none",
                    animation: "rt-slide-in 0.2s ease-out",
                  }}
                >
                  {message.content}
                </div>
              ))}
            </AutoScroll>

            {session.userTranscript !== null && (
              <div
                className="flex items-center px-4 py-2 text-xs italic min-h-8"
                style={{ background: "#fafafa", borderTop: "1px solid #e4e4e7", color: "#71717a" }}
              >
                <span
                  className="w-2 h-2 rounded-full inline-block mr-2"
                  style={{ background: "#16a34a", animation: "rt-pulse 1.5s ease-in-out infinite" }}
                />
                {session.userTranscript === "" ? "…" : session.userTranscript}
              </div>
            )}
            {session.error && (
              <div
                className="px-4 py-2 text-xs"
                style={{ background: "#fef2f2", color: "#b91c1c", borderTop: "1px solid #fecaca" }}
              >
                {session.error.message} ({session.error.code})
              </div>
            )}

            <div
              className="flex items-center gap-2 px-4 py-3"
              style={{ background: "#ffffff", borderTop: "1px solid #e4e4e7" }}
            >
              {!session.started ? (
                <button
                  type="button"
                  className="px-4 py-2 border-none rounded-md text-xs font-semibold cursor-pointer text-white"
                  style={{ background: "#2563eb" }}
                  onClick={() => session.start()}
                >
                  Start call
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="px-4 py-2 border-none rounded-md text-xs font-semibold cursor-pointer"
                    style={{
                      background: session.running ? "#e4e4e7" : "#2563eb",
                      color: session.running ? "#18181b" : "#ffffff",
                    }}
                    onClick={() => session.toggle()}
                  >
                    {session.running ? "Hold" : "Resume"}
                  </button>
                  {/* end() hangs up and flips `started` back, so the UI
                      returns to "Start call" and the next start is a brand-new
                      session (fresh store, greeting included). reset() would
                      keep the call live — the buttons never toggle back. */}
                  <button
                    type="button"
                    className="px-4 py-2 border-none rounded-md text-xs font-semibold cursor-pointer text-white"
                    style={{ background: "#dc2626" }}
                    onClick={() => session.end()}
                  >
                    End
                  </button>
                </>
              )}
              <div className="flex-1" />
              <span className="text-[10px] tabular-nums" style={{ color: "#a1a1aa" }}>
                {view.productCount} products
              </span>
            </div>
          </div>

          {/* Sidebar: the customer file */}
          <div
            className="rt-scroll overflow-y-auto p-3 flex flex-col gap-3"
            style={{ background: "#f4f4f5" }}
          >
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
            {view.callSeq} call{view.callSeq === 1 ? "" : "s"}
          </span>
        </div>
      </div>
    </>
  );
}

client({
  component: App,
  theme: {
    bg: "#f4f4f5",
    primary: "#2563eb",
    text: "#18181b",
    surface: "#ffffff",
    border: "#e4e4e7",
  },
});
