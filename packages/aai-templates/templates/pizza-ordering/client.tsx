import "@alexkroman1/aai-ui/styles.css";
import { useState } from "preact/hooks";
import { ChatView, SidebarLayout, StartScreen, defineClient, useSession, useToolResult } from "@alexkroman1/aai-ui";
import { type Pizza, type PizzaToolResults, pizzaPrice } from "./shared.ts";

interface OrderInfo {
  pizzas: Pizza[];
  total: string;
  orderPlaced: boolean;
  orderNumber?: number;
  estimatedMinutes?: number;
}

function PizzaIcon({ size }: { size: string }) {
  const dim = size === "small" ? 36 : size === "large" ? 52 : 44;
  return (
    <svg
      width={dim}
      height={dim}
      viewBox="0 0 100 100"
      class="shrink-0"
    >
      <circle cx="50" cy="50" r="48" fill="#F4C542" stroke="#D4A017" stroke-width="3" />
      <circle cx="50" cy="50" r="42" fill="#E8A025" />
      <circle cx="35" cy="35" r="7" fill="#C0392B" opacity="0.9" />
      <circle cx="60" cy="30" r="6" fill="#C0392B" opacity="0.9" />
      <circle cx="55" cy="55" r="7" fill="#C0392B" opacity="0.9" />
      <circle cx="30" cy="58" r="6" fill="#C0392B" opacity="0.9" />
      <circle cx="65" cy="65" r="5" fill="#C0392B" opacity="0.9" />
      <circle cx="45" cy="68" r="4" fill="#27AE60" opacity="0.7" />
      <circle cx="70" cy="42" r="4" fill="#27AE60" opacity="0.7" />
    </svg>
  );
}

function OrderPanel({ order }: { order: OrderInfo }) {
  if (order.orderPlaced) {
    return (
      <div class="flex flex-col items-center gap-4 p-6 text-center">
        <div class="text-5xl">&#10003;</div>
        <h2 class="text-lg font-bold text-aai-text">Order Placed</h2>
        {order.orderNumber && (
          <p class="text-aai-text opacity-70">
            Order #{order.orderNumber}
          </p>
        )}
        <p class="text-aai-primary font-bold text-xl">{order.total}</p>
        {order.estimatedMinutes && (
          <p class="text-aai-text opacity-60 text-sm">
            Ready in ~{order.estimatedMinutes} minutes
          </p>
        )}
      </div>
    );
  }

  if (order.pizzas.length === 0) {
    return (
      <div class="flex flex-col items-center gap-3 p-6 text-center opacity-50">
        <PizzaIcon size="large" />
        <p class="text-aai-text text-sm">
          Your order is empty. Tell me what you'd like.
        </p>
      </div>
    );
  }

  return (
    <div class="flex flex-col gap-3 p-4">
      <h3 class="text-sm font-bold text-aai-text opacity-60 uppercase tracking-wide">
        Your Order
      </h3>
      {order.pizzas.map((p) => (
        <div
          key={p.id}
          class="flex items-center gap-3 p-3 rounded-lg bg-aai-surface"
        >
          <PizzaIcon size={p.size} />
          <div class="flex-1 min-w-0">
            <p class="text-aai-text text-sm font-medium">
              {p.quantity > 1 ? `${p.quantity}x ` : ""}
              {p.size.charAt(0).toUpperCase() + p.size.slice(1)}{" "}
              {p.crust} crust
            </p>
            <p class="text-aai-text opacity-60 text-xs truncate">
              {p.toppings.length > 0
                ? p.toppings.map((t) => t.replace("_", " ")).join(", ")
                : "cheese only"}
            </p>
          </div>
          <p class="text-aai-primary text-sm font-bold whitespace-nowrap">
            ${pizzaPrice(p).toFixed(2)}
          </p>
        </div>
      ))}
      <div class="flex justify-between items-center pt-3 mt-1 border-t border-aai-border">
        <span class="text-aai-text font-bold">Total</span>
        <span class="text-aai-primary font-bold text-lg">{order.total}</span>
      </div>
    </div>
  );
}

function PizzaAgent() {
  const { running, toggle, reset } = useSession();
  const [order, setOrder] = useState<OrderInfo>({
    pizzas: [],
    total: "$0.00",
    orderPlaced: false,
  });

  useToolResult<PizzaToolResults["add_pizza"]>("add_pizza", (result) => {
    if (result.added) {
      setOrder((prev) => ({
        ...prev,
        pizzas: [...prev.pizzas, result.added],
        total: result.orderTotal,
      }));
    }
  });

  useToolResult<PizzaToolResults["remove_pizza"]>("remove_pizza", (result) => {
    if (result.removed) {
      setOrder((prev) => ({
        ...prev,
        pizzas: prev.pizzas.filter((p) => p.id !== result.removed.id),
        total: result.orderTotal,
      }));
    }
  });

  useToolResult<PizzaToolResults["update_pizza"]>("update_pizza", (result) => {
    if (result.updated) {
      setOrder((prev) => ({
        ...prev,
        pizzas: prev.pizzas.map((p) =>
          p.id === result.updated.id ? result.updated : p,
        ),
        total: result.orderTotal,
      }));
    }
  });

  useToolResult<PizzaToolResults["view_order"]>("view_order", (result) => {
    if ("pizzas" in result) {
      const total =
        result.orderTotal ||
        `$${result.pizzas.reduce((s: number, p: Pizza) => s + pizzaPrice(p), 0).toFixed(2)}`;
      setOrder((prev) => ({ ...prev, total }));
    }
  });

  useToolResult<PizzaToolResults["place_order"]>("place_order", (result) => {
    if (result.orderNumber) {
      setOrder((prev) => ({
        ...prev,
        orderPlaced: true,
        orderNumber: result.orderNumber,
        total: result.total,
        estimatedMinutes: result.estimatedMinutes,
      }));
    }
  });

  const sidebar = (
    <>
      <div class="p-4 flex items-center gap-3 border-b border-aai-border">
        <PizzaIcon size="small" />
        <h2 class="text-base font-bold text-aai-text">Pizza Palace</h2>
      </div>
      <div class="flex-1">
        <OrderPanel order={order} />
      </div>
      <div class="p-3 flex gap-2 border-t border-aai-border">
        <button
          class={`flex-1 py-2 rounded-lg text-sm border-none cursor-pointer text-white ${running.value ? "bg-aai-error" : "bg-aai-primary"}`}
          onClick={toggle}
        >
          {running.value ? "Pause" : "Resume"}
        </button>
        <button
          class="py-2 px-4 rounded-lg text-sm cursor-pointer text-aai-text bg-aai-surface border border-aai-border"
          onClick={() => {
            reset();
            setOrder({
              pizzas: [],
              total: "$0.00",
              orderPlaced: false,
            });
          }}
        >
          New Order
        </button>
      </div>
    </>
  );

  return (
    <StartScreen icon={<PizzaIcon size="large" />} title="Pizza Palace" subtitle="Voice-powered pizza ordering" buttonText="Start Ordering">
      <SidebarLayout sidebar={sidebar}>
        <ChatView />
      </SidebarLayout>
    </StartScreen>
  );
}

defineClient(PizzaAgent, {
  title: "Pizza Palace",
  theme: {
    bg: "#1a1008",
    primary: "#E8A025",
    text: "#f5f0e8",
    surface: "#2a1f10",
    border: "#3d2e18",
  },
});
