import { defineAgent, tool } from "@alexkroman1/aai";
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

// ─── Safe Math Expression Parser ────────────────────────────────────────
// Recursive-descent parser for arithmetic: +, -, *, /, %, parentheses.
// No eval/Function — only numeric literals and operators are accepted.

function evalMath(expr: string): number {
  let pos = 0;
  const src = expr.replace(/\s+/g, "");

  function parseExpr(): number {
    let left = parseTerm();
    while (pos < src.length && (src[pos] === "+" || src[pos] === "-")) {
      const op = src[pos++];
      const right = parseTerm();
      left = op === "+" ? left + right : left - right;
    }
    return left;
  }

  function parseTerm(): number {
    let left = parseUnary();
    while (
      pos < src.length &&
      (src[pos] === "*" || src[pos] === "/" || src[pos] === "%")
    ) {
      const op = src[pos++];
      const right = parseUnary();
      if (op === "*") left = left * right;
      else if (op === "/") left = left / right;
      else left = left % right;
    }
    return left;
  }

  function parseUnary(): number {
    if (src[pos] === "-") {
      pos++;
      return -parseUnary();
    }
    if (src[pos] === "+") {
      pos++;
      return parseUnary();
    }
    return parsePrimary();
  }

  function parsePrimary(): number {
    if (src[pos] === "(") {
      pos++; // skip '('
      const val = parseExpr();
      if (src[pos] !== ")") throw new Error("Missing closing parenthesis");
      pos++; // skip ')'
      return val;
    }
    const start = pos;
    while (pos < src.length) {
      const ch = src[pos]!;
      if ((ch >= "0" && ch <= "9") || ch === ".") pos++;
      else break;
    }
    if (pos === start) throw new Error("Unexpected token");
    const num = Number(src.slice(start, pos));
    if (Number.isNaN(num)) throw new Error("Invalid number");
    return num;
  }

  const result = parseExpr();
  if (pos < src.length) throw new Error("Unexpected trailing characters");
  return result;
}

// ─── Rate Limiter Middleware ─────────────────────────────────────────────
// Limits the number of turns per session within a time window.

function rateLimiter(maxTurns = 20, windowMs = 60_000): Middleware {
  return {
    name: "rate-limiter",
    beforeTurn: (text, ctx) => {
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
    outputFilter: (text) => {
      let filtered = text;
      for (const [pattern, replacement] of patterns) {
        filtered = filtered.replace(pattern, replacement);
      }
      if (filtered !== text) {
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
    beforeTurn: (text, _ctx) => {
      console.log(`[analytics] Turn started: "${text.slice(0, 50)}..."`);
      return undefined;
    },
    afterTurn: (text, ctx) => {
      console.log(`[analytics] Turn completed for session`);
    },
    toolCallInterceptor: (toolName, args, _ctx) => {
      console.log(`[analytics] Tool call: ${toolName}`, args);
      return undefined;
    },
  };
}

// ─── Tool Call Cache Middleware ───────────────────────────────────────────
// Caches tool results to avoid redundant calls within a session.

function toolCallCache(): Middleware {
  return {
    name: "tool-call-cache",
    toolCallInterceptor: (toolName, args, ctx) => {
      const state = ctx.state as {
        _cache?: Record<string, string>;
      };
      if (!state._cache) state._cache = {};
      const key = `${toolName}:${JSON.stringify(args)}`;
      if (state._cache[key]) {
        console.log(`[cache] Cache hit: ${toolName}`);
        return { result: state._cache[key] };
      }
    },
    afterToolCall: (toolName, args, result, ctx) => {
      const state = ctx.state as {
        _cache?: Record<string, string>;
      };
      if (!state._cache) state._cache = {};
      const key = `${toolName}:${JSON.stringify(args)}`;
      state._cache[key] = result;
      console.log(`[cache] Cached result for: ${toolName}`);
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
    get_weather: tool({
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

    calculate: tool({
      description: "Calculate a math expression (supports +, -, *, /, %, parentheses)",
      parameters: z.object({
        expression: z.string().describe("Math expression to evaluate"),
      }),
      execute: ({ expression }) => {
        try {
          const result = evalMath(expression);
          return { expression, result };
        } catch {
          return { expression, error: "Invalid expression" };
        }
      },
    }),
  },
});
