import { defineAgent, defineTool } from "@alexkroman1/aai";
import type { ToolContext } from "@alexkroman1/aai";
import { z } from "zod";

type GameState = {
  inventory: string[];
  currentRoom: string;
  score: number;
  moves: number;
  flags: Record<string, boolean>;
  history: string[];
};

function s(ctx: ToolContext): GameState {
  return ctx.state as GameState;
}

export default defineAgent({
  name: "Infocom Adventure",
  greeting:
    "Welcome to the great underground empire. You are standing in an open field west of a white house, with a boarded front door. There is a small mailbox here. What would you like to do?",

  state: (): GameState => ({
    inventory: [],
    currentRoom: "West of House",
    score: 0,
    moves: 0,
    flags: {},
    history: [],
  }),

  systemPrompt:
    `You are a classic Infocom-style text adventure game engine, simulating ZORK I: The Great Underground Empire.

You ARE the game. You maintain the world state, describe rooms, handle puzzles, manage inventory, track score, and respond to player commands — all faithfully recreating the Zork experience.

GAME WORLD RULES:
- Follow the geography, puzzles, and items of Zork I as closely as you can recall
- The map includes: West of House, North of House, Behind House, South of House, Kitchen, Living Room, Attic, Cellar, the Great Underground Empire (Troll Room, Flood Control Dam, Loud Room, etc.), the maze, Hades, and more
- Key items: brass lantern, elvish sword, jeweled egg, gold coffin, platinum bar, jade figurine, sapphire bracelet, trunk of jewels, crystal trident, etc.
- Key encounters: troll, thief, cyclops, spirits, vampire bat
- Puzzles work as they do in Zork: the dam, the coal mine, the Egyptian room, the mirror rooms, Hades, the maze, etc.
- Score increases when the player collects treasures and places them in the trophy case in the living room
- The brass lantern has limited battery life underground

VOICE-FIRST RESPONSE RULES:
- Describe rooms vividly but concisely — two to four sentences max
- For movement, describe the new room immediately
- For failed actions, give brief, witty responses in the Infocom style ("There is a wall in the way." or "You can't eat that.")
- Read inventory as a spoken list
- Announce score changes
- Keep the classic dry humor of Infocom games
- Never use visual formatting — no bullets, no bold, no lists with dashes
- Use "First... Then... Finally..." for sequences
- Use directional words naturally: "To the north you see..." not "N: forest"

COMMAND INTERPRETATION:
- Players speak naturally. Translate their voice into classic adventure commands
- "go north" / "head north" / "walk north" = north
- "pick up the sword" / "grab the sword" / "take sword" = take sword
- "what do I have" / "check my stuff" / "inventory" = inventory
- "where am I" / "look around" / "describe the room" = look
- "hit the troll" / "fight the troll" / "attack troll" = attack troll with sword
- "what's my score" = score
- Accept natural conversational commands and map them to game actions

Use the game state tools to track inventory, location, score, and flags. Use game_state_get to read the current state, game_state_move to change rooms, game_state_take to pick up items, game_state_drop to drop items, game_state_score to add points, game_state_flag to set game flags, and game_state_history to log commands. Always update state when the player takes an item, moves rooms, or triggers an event. Check state before responding to ensure consistency.

ATMOSPHERE:
- Underground areas should feel dark and foreboding when the lantern is present, and terrifying in pitch blackness
- The thief should appear randomly and steal items
- The troll blocks the passage until defeated
- Convey a sense of mystery and danger
- Keep the wry, understated humor that made Infocom games legendary`,

  tools: {
    game_state_get: {
      description:
        "Read the current game state including inventory, current room, score, moves, flags, and recent history.",
      execute: (_args, ctx) => {
        const g = s(ctx);
        return {
          currentRoom: g.currentRoom,
          inventory: g.inventory,
          score: g.score,
          moves: g.moves,
          flags: g.flags,
          recentHistory: g.history.slice(-5),
        };
      },
    },
    game_state_move: defineTool({
      description:
        "Move the player to a new room and increment the move counter.",
      parameters: z.object({
        value: z.string().describe("Room name to move to"),
      }),
      execute: ({ value }, ctx) => {
        const g = s(ctx);
        g.currentRoom = value;
        g.moves++;
        return { currentRoom: g.currentRoom, moves: g.moves };
      },
    }),
    game_state_take: defineTool({
      description: "Add an item to the player's inventory.",
      parameters: z.object({
        value: z.string().describe("Item name to take"),
      }),
      execute: ({ value }, ctx) => {
        const g = s(ctx);
        if (!g.inventory.includes(value)) g.inventory.push(value);
        return { inventory: g.inventory };
      },
    }),
    game_state_drop: defineTool({
      description: "Remove an item from the player's inventory.",
      parameters: z.object({
        value: z.string().describe("Item name to drop"),
      }),
      execute: ({ value }, ctx) => {
        const g = s(ctx);
        g.inventory = g.inventory.filter((i) => i !== value);
        return { inventory: g.inventory };
      },
    }),
    game_state_score: defineTool({
      description: "Add points to the player's score.",
      parameters: z.object({
        value: z.number().describe("Points to add"),
      }),
      execute: ({ value }, ctx) => {
        const g = s(ctx);
        g.score += value;
        return { score: g.score };
      },
    }),
    game_state_flag: defineTool({
      description:
        "Set a game flag to true, used for tracking puzzle and event state.",
      parameters: z.object({
        value: z.string().describe("Flag name to set"),
      }),
      execute: ({ value }, ctx) => {
        const g = s(ctx);
        g.flags[value] = true;
        return { flags: g.flags };
      },
    }),
    game_state_history: defineTool({
      description:
        "Log a player command to the history and increment the move counter.",
      parameters: z.object({
        value: z.string().describe("Command text to log"),
      }),
      execute: ({ value }, ctx) => {
        const g = s(ctx);
        g.history.push(value);
        g.moves++;
        return { moves: g.moves, recentHistory: g.history.slice(-5) };
      },
    }),
  },
});
