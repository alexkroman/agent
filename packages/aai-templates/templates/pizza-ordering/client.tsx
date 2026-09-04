import { formatMoney } from "@alexkroman1/aai/utils";
import "@alexkroman1/aai-ui/styles.css";
import { mountClient, useAgentState } from "@alexkroman1/aai-ui";
import { orderProjection, pizzaPrice } from "./shared.ts";

function PizzaIcon({ size }: { size: string }) {
  const dim = size === "small" ? 36 : size === "large" ? 52 : 44;
  return (
    <svg width={dim} height={dim} viewBox="0 0 100 100" className="shrink-0">
      <circle cx="50" cy="50" r="48" fill="#F4C542" stroke="#D4A017" strokeWidth="3" />
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

function OrderSidebar() {
  // The agent's own cart, projected by `syncState` and pushed after every
  // tool call. This replaced ~45 lines that rebuilt the cart by diffing
  // added/removed/updated events — where one missed event desynced the view
  // for the rest of the session.
  const order = useAgentState(orderProjection);

  if (order.orderPlaced) {
    return (
      <div className="flex flex-col items-center gap-4 p-6 text-center text-aai-text">
        <div className="text-5xl">&#10003;</div>
        <h2 className="text-lg font-bold">Order Placed</h2>
        {order.orderNumber && <p className="opacity-70">Order #{order.orderNumber}</p>}
        <p className="font-bold text-xl text-aai-primary">{order.total}</p>
        {order.estimatedMinutes && (
          <p className="opacity-60 text-sm">Ready in ~{order.estimatedMinutes} minutes</p>
        )}
      </div>
    );
  }

  if (order.pizzas.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 p-6 text-center opacity-50">
        <PizzaIcon size="large" />
        <p className="text-sm text-aai-text">Your order is empty. Tell me what you'd like.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-4 text-aai-text">
      <h3 className="text-sm font-bold opacity-60 uppercase tracking-wide">Your Order</h3>
      {order.pizzas.map((p) => (
        <div key={p.id} className="flex items-center gap-3 p-3 rounded-lg bg-aai-surface">
          <PizzaIcon size={p.size} />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">
              {p.quantity > 1 ? `${p.quantity}x ` : ""}
              {p.size.charAt(0).toUpperCase() + p.size.slice(1)} {p.crust} crust
            </p>
            <p className="opacity-60 text-xs truncate">
              {p.toppings.length > 0
                ? p.toppings.map((t) => t.replace("_", " ")).join(", ")
                : "cheese only"}
            </p>
          </div>
          <p className="text-sm font-bold whitespace-nowrap text-aai-primary">
            {formatMoney(pizzaPrice(p))}
          </p>
        </div>
      ))}
      <div className="flex justify-between items-center pt-3 mt-1 border-t border-aai-border">
        <span className="font-bold">Total</span>
        <span className="font-bold text-lg text-aai-primary">{order.total}</span>
      </div>
    </div>
  );
}

mountClient({
  name: "Pizza Palace",
  sidebar: OrderSidebar,
  theme: {
    bg: "#1a1008",
    primary: "#E8A025",
    text: "#f5f0e8",
    surface: "#2a1f10",
    border: "#3d2e18",
  },
  tools: {
    add_pizza: { icon: "\u{1F355}", label: "Adding pizza" },
    remove_pizza: { icon: "\u{1F5D1}", label: "Removing pizza" },
    update_pizza: { icon: "\u{270F}", label: "Updating pizza" },
    place_order: { icon: "\u{2705}", label: "Placing order" },
  },
});
