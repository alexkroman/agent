import { agent, tool } from "@alexkroman1/aai";
import { z } from "zod";
import { gameSlot, recordCommand } from "./shared.ts";
import systemPrompt from "./system-prompt.md?raw";

export default agent({
  name: "Cavern Adventure",
  // A narrator wants a narrative voice; everything else stays on the
  // default all-AssemblyAI pipeline.
  voice: "paul",
  systemPrompt,
  // The opening scene here must agree with DEFAULT_GAME_STATE.currentRoom
  // (shared.ts) and the world map in system-prompt.md.
  greeting:
    "Welcome, adventurer. You are standing at the mouth of a weathered cave at the edge of a pine forest. A cold wind carries the smell of damp stone up from the darkness below. A rusted lantern hangs from an iron hook beside the entrance. What would you like to do?",

  tools: {
    game_state_drop: tool({
      description: "Remove an item from the player's inventory.",
      input: z.object({
        value: z.string().describe("Item name to drop"),
      }),
      async run(args, ctx) {
        const g = gameSlot.get(ctx);
        g.inventory = g.inventory.filter((i) => i !== args.value);
        return { inventory: g.inventory };
      },
    }),

    game_state_flag: tool({
      description: "Set a game flag to true, used for tracking puzzle and event state.",
      input: z.object({
        value: z.string().describe("Flag name to set"),
      }),
      async run(args, ctx) {
        const g = gameSlot.get(ctx);
        g.flags[args.value] = true;
        return { flags: g.flags };
      },
    }),

    game_state_get: tool({
      description:
        "Read the current game state including inventory, current room, score, moves, flags, and recent history.",
      async run(_args, ctx) {
        const g = gameSlot.get(ctx);
        return {
          currentRoom: g.currentRoom,
          inventory: g.inventory,
          score: g.score,
          moves: g.moves,
          flags: g.flags,
          recentHistory: g.history.slice(-5),
        };
      },
    }),

    game_state_history: tool({
      description: "Log a player command to the history and increment the move counter.",
      input: z.object({
        value: z.string().describe("Command text to log"),
      }),
      async run(args, ctx) {
        const g = gameSlot.get(ctx);
        recordCommand(g, args.value);
        g.moves++;
        return { moves: g.moves, recentHistory: g.history.slice(-5) };
      },
    }),

    game_state_move: tool({
      description: "Move the player to a new room and increment the move counter.",
      input: z.object({
        value: z.string().describe("Room name to move to"),
      }),
      async run(args, ctx) {
        const g = gameSlot.get(ctx);
        g.currentRoom = args.value;
        g.moves++;
        return { currentRoom: g.currentRoom, moves: g.moves };
      },
    }),

    game_state_restart: tool({
      description:
        "Reset the game to the beginning: empty inventory, zero score and moves, all flags cleared. Use when the player asks to restart, quit, or start a new game.",
      async run(_args, ctx) {
        const g = gameSlot.reset(ctx);
        return { restarted: true, currentRoom: g.currentRoom };
      },
    }),

    game_state_score: tool({
      description: "Add points to the player's score.",
      input: z.object({
        value: z.number().describe("Points to add"),
      }),
      async run(args, ctx) {
        const g = gameSlot.get(ctx);
        g.score += args.value;
        return { score: g.score };
      },
    }),

    game_state_take: tool({
      description: "Add an item to the player's inventory.",
      input: z.object({
        value: z.string().describe("Item name to take"),
      }),
      async run(args, ctx) {
        const g = gameSlot.get(ctx);
        if (!g.inventory.includes(args.value)) g.inventory.push(args.value);
        return { inventory: g.inventory };
      },
    }),
  },
});
