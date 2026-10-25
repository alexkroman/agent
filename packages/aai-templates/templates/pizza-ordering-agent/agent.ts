import { agent } from "@alexkroman1/aai";
import { menuText } from "./shared.ts";

// The in-progress order lives in one `sessionSlot` (see shared.ts) —
// per-session by construction, so concurrent customers each get their own cart,
// and `sync: true` there is what pushes it to the page after every tool call.
// The six tools that read and write it are the six files in `tools/`: a file
// there IS a tool, named by its own filename, so nothing registers them here.

export default agent({
  name: "Pizza Palace",
  listing: "Takes pizza orders over the phone, from first topping to checkout",
  // Appended under `system-prompt.md`, and generated from MENU so the prompt
  // can never quote a price the pricing code doesn't charge.
  promptContext: menuText(),
  greeting:
    "Welcome to Pizza Palace. I can help you build your perfect pizza. What would you like to order?",
});
