import { agent, tool } from "aai";
import { z } from "zod";
import { getGameState, saveGameState } from "./_shared.ts";
import systemPrompt from "./system-prompt.md";

export default agent({
  name: "Infocom Adventure",
  systemPrompt,
  greeting:
    "Welcome to the great underground empire. You are standing in an open field west of a white house, with a boarded front door. There is a small mailbox here. What would you like to do?",

  tools: {
    game_state_drop: tool({
      description: "Remove an item from the player's inventory.",
      parameters: z.object({
        value: z.string().describe("Item name to drop"),
      }),
      async execute(args, ctx) {
        const g = await getGameState(ctx.kv);
        g.inventory = g.inventory.filter((i) => i !== args.value);
        await saveGameState(ctx.kv, g);
        return { inventory: g.inventory };
      },
    }),

    game_state_flag: tool({
      description: "Set a game flag to true, used for tracking puzzle and event state.",
      parameters: z.object({
        value: z.string().describe("Flag name to set"),
      }),
      async execute(args, ctx) {
        const g = await getGameState(ctx.kv);
        g.flags[args.value] = true;
        await saveGameState(ctx.kv, g);
        return { flags: g.flags };
      },
    }),

    game_state_get: tool({
      description:
        "Read the current game state including inventory, current room, score, moves, flags, and recent history.",
      async execute(_args, ctx) {
        const g = await getGameState(ctx.kv);
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
      parameters: z.object({
        value: z.string().describe("Command text to log"),
      }),
      async execute(args, ctx) {
        const g = await getGameState(ctx.kv);
        g.history.push(args.value);
        g.moves++;
        await saveGameState(ctx.kv, g);
        return { moves: g.moves, recentHistory: g.history.slice(-5) };
      },
    }),

    game_state_move: tool({
      description: "Move the player to a new room and increment the move counter.",
      parameters: z.object({
        value: z.string().describe("Room name to move to"),
      }),
      async execute(args, ctx) {
        const g = await getGameState(ctx.kv);
        g.currentRoom = args.value;
        g.moves++;
        await saveGameState(ctx.kv, g);
        return { currentRoom: g.currentRoom, moves: g.moves };
      },
    }),

    game_state_score: tool({
      description: "Add points to the player's score.",
      parameters: z.object({
        value: z.number().describe("Points to add"),
      }),
      async execute(args, ctx) {
        const g = await getGameState(ctx.kv);
        g.score += args.value;
        await saveGameState(ctx.kv, g);
        return { score: g.score };
      },
    }),

    game_state_take: tool({
      description: "Add an item to the player's inventory.",
      parameters: z.object({
        value: z.string().describe("Item name to take"),
      }),
      async execute(args, ctx) {
        const g = await getGameState(ctx.kv);
        if (!g.inventory.includes(args.value)) g.inventory.push(args.value);
        await saveGameState(ctx.kv, g);
        return { inventory: g.inventory };
      },
    }),
  },
});
