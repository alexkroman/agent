import { agent } from "@alexkroman1/aai";
import { menuText, orderSlot, orderView } from "./shared.ts";
import systemPrompt from "./system-prompt.md?raw";

// The in-progress order lives in `ctx.state` (see shared.ts) — per-session by
// construction, so concurrent customers each get their own cart. The six tools
// that read and write it are the six files in `tools/`: a file there IS a tool,
// named by its own filename, so nothing registers them here.

export default agent({
  name: "Pizza Palace",
  // `orderSlot.state` IS the `() => ({ [slot.key]: slot.create() })` factory,
  // so the session's cart exists before the first tool call — which is what a
  // resumed connection needs to have something to project.
  state: orderSlot.state,
  // The cart, pushed to the client after every tool call. Replaces a
  // `ctx.send("order", ...)` in each of the five order tools, and the
  // event-diffing the client had to do to rebuild the cart from them.
  syncState: orderSlot.projection(orderView),
  // The menu section is generated from MENU so the prompt can never quote a
  // price the pricing code doesn't charge.
  systemPrompt: `${systemPrompt}\n${menuText()}`,
  greeting:
    "Welcome to Pizza Palace. I can help you build your perfect pizza. What would you like to order?",
});
