import { clientTool } from "@alexkroman1/aai";

/**
 * The kitchen, as the cook's own screen has it: their name, how many they cook for, the
 * diet and the pantry. A clientTool, because the PAGE holds it (a form remembered in
 * this browser) and nothing on the server does: the model calls it like any tool, and
 * the page's `useClientTool("get_kitchen", …)` answers with `kitchenFrom(form)`.
 *
 * No `inputSchema`: there is nothing to ask the page for but all of it.
 */
export default clientTool({
  description:
    "Read the cook's kitchen from their screen: their name, how many people they cook " +
    "for, their diet, and what is in their pantry. Call it before suggesting or scaling " +
    "a recipe, and again when they say they changed something.",
  ui: { icon: "\u{1F9C2}", label: "Checking the kitchen" },
});
