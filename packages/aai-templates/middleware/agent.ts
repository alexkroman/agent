import { defineAgent, defineTool } from "@alexkroman1/aai";
import type { Middleware } from "@alexkroman1/aai";
import { z } from "zod";

/**
 * Middleware Agent — demonstrates the middleware / interceptors system.
 *
 * Middleware runs at three points in the agent lifecycle:
 * 1. Before/after turn — inject context, log analytics, apply guardrails
 * 2. Tool call interceptors — approve/deny tool calls, transform args, cache results
 * 3. Output filters — profanity filtering, PII redaction before TTS
 *
 * Middleware composes in order: first middleware wraps second wraps third, etc.
 */

// ─── Rate Limiter Middleware ─────────────────────────────────────────────
// Limits the number of turns per session within a time window.

function rateLimiter(maxTurns = 20, windowMs = 60_000): Middleware {
  return {
    name: "rate-limiter",
    beforeTurn: (ctx) => {
      const state = ctx.state as {
        _rl?: { count: number; windowStart: number };
      };
      const now = Date.now();
      if (!state._rl || now - state._rl.windowStart > windowMs) {
        state._rl = { count: 0, windowStart: now };
      }
      state._rl.count++;
      if (state._rl.count > maxTurns) {
        console.log(
          `[rate-limiter] Turn blocked: ${state._rl.count}/${maxTurns} in window`,
        );
        return { block: true, reason: "Rate limit exceeded. Please slow down." };
      }
      console.log(
        `[rate-limiter] Turn ${state._rl.count}/${maxTurns} allowed`,
      );
    },
  };
}

// ─── PII Redactor Middleware ─────────────────────────────────────────────
// Redacts common PII patterns from agent output before TTS.

function piiRedactor(): Middleware {
  // Simple patterns for demonstration — real PII detection would use a
  // more robust library or service.
  const patterns: [RegExp, string][] = [
    [/\b\d{3}[-.]?\d{2}[-.]?\d{4}\b/g, "[SSN REDACTED]"],
    [/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, "[CARD REDACTED]"],
    [
      /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
      "[EMAIL REDACTED]",
    ],
    [/\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, "[PHONE REDACTED]"],
  ];

  return {
    name: "pii-redactor",
    beforeOutput: (ctx) => {
      let filtered = (ctx.text ?? "");
      for (const [pattern, replacement] of patterns) {
        filtered = filtered.replace(pattern, replacement);
      }
      if (filtered !== ctx.text) {
        console.log("[pii-redactor] Redacted PII from output");
      }
      return filtered;
    },
  };
}

// ─── Analytics Logger Middleware ─────────────────────────────────────────
// Logs turn and tool call analytics for monitoring.

function analyticsLogger(): Middleware {
  return {
    name: "analytics-logger",
    beforeTurn: (ctx) => {
      console.log(`[analytics] Turn started: "${(ctx.text ?? "").slice(0, 50)}..."`);
      return undefined;
    },
    afterTurn: () => {
      console.log(`[analytics] Turn completed for session`);
    },
    beforeToolCall: (ctx) => {
      console.log(`[analytics] Tool call: ${ctx.tool}`, ctx.args);
      return undefined;
    },
  };
}

// ─── Tool Call Cache Middleware ───────────────────────────────────────────
// Caches tool results to avoid redundant calls within a session.

function toolCallCache(): Middleware {
  return {
    name: "tool-call-cache",
    beforeToolCall: (ctx) => {
      const state = ctx.state as {
        _cache?: Record<string, string>;
      };
      if (!state._cache) state._cache = {};
      const key = `${ctx.tool}:${JSON.stringify(ctx.args)}`;
      if (state._cache[key]) {
        console.log(`[cache] Cache hit: ${ctx.tool}`);
        return { result: state._cache[key] };
      }
    },
    afterToolCall: (ctx) => {
      const state = ctx.state as {
        _cache?: Record<string, string>;
      };
      if (!state._cache) state._cache = {};
      const key = `${ctx.tool}:${JSON.stringify(ctx.args)}`;
      state._cache[key] = (ctx.result ?? "");
      console.log(`[cache] Cached result for: ${ctx.tool}`);
    },
  };
}

// ─── Agent Definition ────────────────────────────────────────────────────

export default defineAgent({
  name: "Middleware Demo",
  instructions: `You are a helpful assistant that demonstrates middleware. \
You can search the web, look up the weather, and do math. \
Keep answers short and conversational.`,
  greeting:
    "Hey there. I'm a middleware demo agent. Ask me anything to see the middleware in action.",
  builtinTools: ["web_search"],

  middleware: [
    rateLimiter(20, 60_000),
    piiRedactor(),
    analyticsLogger(),
    toolCallCache(),
  ],

  state: () => ({
    turnCount: 0,
  }),

  tools: {
    get_weather: defineTool({
      description: "Get current weather for a city",
      parameters: z.object({
        city: z.string().describe("City name"),
      }),
      execute: async ({ city }) => {
        // Simulated weather data for demo purposes
        const temp = Math.round(15 + Math.random() * 20);
        return {
          city,
          temperature: `${temp}C`,
          condition: "partly cloudy",
        };
      },
    }),

    calculate: defineTool({
      description: "Calculate a math expression",
      parameters: z.object({
        expression: z.string().describe("Math expression to evaluate"),
      }),
      execute: ({ expression }) => {
        // Simple calculator — safe subset
        const sanitized = expression.replace(/[^0-9+\-*/().% ]/g, "");
        try {
          // biome-ignore lint/security/noGlobalEval: intentional for demo calculator
          const result = new Function(`return (${sanitized})`)();
          return { expression, result };
        } catch {
          return { expression, error: "Invalid expression" };
        }
      },
    }),
  },
});
