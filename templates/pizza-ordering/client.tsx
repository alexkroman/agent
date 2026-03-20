import "@alexkroman1/aai/ui/styles.css";
import { useState } from "preact/hooks";
import { ChatView, SidebarLayout, StartScreen, mount, useSession, useToolResult } from "@alexkroman1/aai/ui";

interface Pizza {
  id: number;
  size: string;
  crust: string;
  toppings: string[];
  quantity: number;
}

interface OrderInfo {
  pizzas: Pizza[];
  total: string;
  orderPlaced: boolean;
  orderNumber?: number;
  estimatedMinutes?: number;
}

const SIZE_PRICES: Record<string, number> = {
  small: 8.99,
  medium: 11.99,
  large: 14.99,
};
const CRUST_PRICES: Record<string, number> = {
  thin: 0,
  regular: 0,
  thick: 1.0,
  stuffed: 2.0,
};
const TOPPING_PRICES: Record<string, number> = {
  pepperoni: 1.5,
  sausage: 1.5,
  mushrooms: 1.0,
  onions: 1.0,
  green_peppers: 1.0,
  black_olives: 1.0,
  bacon: 2.0,
  ham: 1.5,
  pineapple: 1.0,
  jalapenos: 1.0,
  extra_cheese: 1.5,
  spinach: 1.0,
  tomatoes: 1.0,
  anchovies: 1.5,
  chicken: 2.0,
};

function pizzaPrice(p: Pizza): number {
  const base = SIZE_PRICES[p.size] ?? 11.99;
  const crust = CRUST_PRICES[p.crust] ?? 0;
  const toppings = p.toppings.reduce(
    (s, t) => s + (TOPPING_PRICES[t] ?? 1.0),
    0,
  );
  return (base + crust + toppings) * p.quantity;
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

  useToolResult((toolName, result: any) => {
    switch (toolName) {
      case "add_pizza":
        if (result.added) {
          setOrder((prev) => ({
            ...prev,
            pizzas: [...prev.pizzas, result.added],
            total: result.orderTotal,
          }));
        }
        break;
      case "remove_pizza":
        if (result.removed) {
          setOrder((prev) => ({
            ...prev,
            pizzas: prev.pizzas.filter(
              (p: Pizza) => p.id !== result.removed.id,
            ),
            total: result.orderTotal,
          }));
        }
        break;
      case "update_pizza":
        if (result.updated) {
          setOrder((prev) => ({
            ...prev,
            pizzas: prev.pizzas.map((p: Pizza) =>
              p.id === result.updated.id ? result.updated : p,
            ),
            total: result.orderTotal,
          }));
        }
        break;
      case "view_order":
        if (result.pizzas) {
          const total =
            result.orderTotal ||
            `$${result.pizzas.reduce((s: number, p: Pizza) => s + pizzaPrice(p), 0).toFixed(2)}`;
          setOrder((prev) => ({ ...prev, total }));
        }
        break;
      case "place_order":
        if (result.orderNumber) {
          setOrder((prev) => ({
            ...prev,
            orderPlaced: true,
            orderNumber: result.orderNumber,
            total: result.total,
            estimatedMinutes: result.estimatedMinutes,
          }));
        }
        break;
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

mount(PizzaAgent, {
  title: "Pizza Palace",
  theme: {
    bg: "#1a1008",
    primary: "#E8A025",
    text: "#f5f0e8",
    surface: "#2a1f10",
    border: "#3d2e18",
  },
});
