type GameState = {
  inventory: string[];
  currentRoom: string;
  score: number;
  moves: number;
  flags: Record<string, boolean>;
  history: string[];
};

function s(ctx: ToolContext<GameState>): GameState {
  return ctx.state;
}

export default {
  state: (): GameState => ({
    inventory: [],
    currentRoom: "West of House",
    score: 0,
    moves: 0,
    flags: {},
    history: [],
  }),

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
    game_state_move: {
      description:
        "Move the player to a new room and increment the move counter.",
      parameters: {
        type: "object" as const,
        properties: {
          value: { type: "string", description: "Room name to move to" },
        },
        required: ["value"],
      },
      execute: (args: Record<string, unknown>, ctx: ToolContext<GameState>) => {
        const value = args.value as string;
        const g = s(ctx);
        g.currentRoom = value;
        g.moves++;
        return { currentRoom: g.currentRoom, moves: g.moves };
      },
    },
    game_state_take: {
      description: "Add an item to the player's inventory.",
      parameters: {
        type: "object" as const,
        properties: {
          value: { type: "string", description: "Item name to take" },
        },
        required: ["value"],
      },
      execute: (args: Record<string, unknown>, ctx: ToolContext<GameState>) => {
        const value = args.value as string;
        const g = s(ctx);
        if (!g.inventory.includes(value)) g.inventory.push(value);
        return { inventory: g.inventory };
      },
    },
    game_state_drop: {
      description: "Remove an item from the player's inventory.",
      parameters: {
        type: "object" as const,
        properties: {
          value: { type: "string", description: "Item name to drop" },
        },
        required: ["value"],
      },
      execute: (args: Record<string, unknown>, ctx: ToolContext<GameState>) => {
        const value = args.value as string;
        const g = s(ctx);
        g.inventory = g.inventory.filter((i) => i !== value);
        return { inventory: g.inventory };
      },
    },
    game_state_score: {
      description: "Add points to the player's score.",
      parameters: {
        type: "object" as const,
        properties: {
          value: { type: "number", description: "Points to add" },
        },
        required: ["value"],
      },
      execute: (args: Record<string, unknown>, ctx: ToolContext<GameState>) => {
        const value = args.value as number;
        const g = s(ctx);
        g.score += value;
        return { score: g.score };
      },
    },
    game_state_flag: {
      description:
        "Set a game flag to true, used for tracking puzzle and event state.",
      parameters: {
        type: "object" as const,
        properties: {
          value: { type: "string", description: "Flag name to set" },
        },
        required: ["value"],
      },
      execute: (args: Record<string, unknown>, ctx: ToolContext<GameState>) => {
        const value = args.value as string;
        const g = s(ctx);
        g.flags[value] = true;
        return { flags: g.flags };
      },
    },
    game_state_history: {
      description:
        "Log a player command to the history and increment the move counter.",
      parameters: {
        type: "object" as const,
        properties: {
          value: { type: "string", description: "Command text to log" },
        },
        required: ["value"],
      },
      execute: (args: Record<string, unknown>, ctx: ToolContext<GameState>) => {
        const value = args.value as string;
        const g = s(ctx);
        g.history.push(value);
        g.moves++;
        return { moves: g.moves, recentHistory: g.history.slice(-5) };
      },
    },
  },
} satisfies AgentTools<GameState>;
