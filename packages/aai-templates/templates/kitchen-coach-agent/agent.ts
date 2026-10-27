import { agent } from "@alexkroman1/aai";
import { history } from "./history.ts";

// A cooking coach for someone with flour on their hands. The page is where the KITCHEN
// lives — who is cooking, for how many, the diet, what is in the pantry, the timers that
// are running — and the agent reaches it through two client tools (tools/get_kitchen.ts,
// tools/start_timer.ts): the model calls them like any tool, and the open page answers
// (useClientTool in client.tsx). Nothing about the kitchen is stored on the server.
//
// The page is the SDK's own pieces composed rather than drawn: StartScreen, then a
// SidebarLayout with the kitchen form (TextField, NumberField, SelectField,
// TextAreaField, each remembered in this browser with useStoredValue) beside ChatView.
//
// GET /api/history is the sidebar's "Earlier" list: what this browser's past sessions
// said, read from the runtime's own log by the page's ?client= id (history.ts).
export default agent({
  name: "Kitchen Coach",
  listing:
    "A hands-free cooking coach: recipes from your pantry, scaled to your table, with timers",
  greeting: "Hi, I'm your kitchen coach. What are we making today?",
  routes: { "GET /history": history },
});
