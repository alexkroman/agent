/** @jsxImportSource react */

import "@alexkroman1/aai-ui/styles.css";
import { client, useTheme, useToolResult } from "@alexkroman1/aai-ui";
import { useState } from "react";
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
  const theme = useTheme();
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
        pizzas: prev.pizzas.map((p) => (p.id === result.updated.id ? result.updated : p)),
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

  if (order.orderPlaced) {
    return (
      <div
        className="flex flex-col items-center gap-4 p-6 text-center"
        style={{ color: theme.text }}
      >
        <div className="text-5xl">&#10003;</div>
        <h2 className="text-lg font-bold">Order Placed</h2>
        {order.orderNumber && <p className="opacity-70">Order #{order.orderNumber}</p>}
        <p className="font-bold text-xl" style={{ color: theme.primary }}>
          {order.total}
        </p>
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
        <p className="text-sm" style={{ color: theme.text }}>
          Your order is empty. Tell me what you'd like.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-4" style={{ color: theme.text }}>
      <h3 className="text-sm font-bold opacity-60 uppercase tracking-wide">Your Order</h3>
      {order.pizzas.map((p) => (
        <div
          key={p.id}
          className="flex items-center gap-3 p-3 rounded-lg"
          style={{ background: theme.surface }}
        >
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
          <p className="text-sm font-bold whitespace-nowrap" style={{ color: theme.primary }}>
            ${pizzaPrice(p).toFixed(2)}
          </p>
        </div>
      ))}
      <div
        className="flex justify-between items-center pt-3 mt-1 border-t"
        style={{ borderColor: theme.border }}
      >
        <span className="font-bold">Total</span>
        <span className="font-bold text-lg" style={{ color: theme.primary }}>
          {order.total}
        </span>
      </div>
    </div>
  );
}

client({
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
