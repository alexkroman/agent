# Plan: Agent Transfer, Escalation & Human Handoff

**Status**: draft
**Issue**: F15 — No agent transfer, escalation, or human handoff mechanism
**Copeland**: 26.5 | **Pairwise**: 26W-5L-1T

## Problem

There is no primitive for transferring a conversation to another agent or
escalating to a human operator. This blocks customer service, healthcare triage,
and enterprise support workflows where the voice agent must gracefully hand off
when it reaches its capability boundary.

## Design Principles

1. **Tool-based, not protocol-based.** Escalation is a tool the LLM calls —
   not a new wire protocol message. This keeps the client protocol unchanged and
   lets the LLM decide *when* to escalate based on conversation context.
2. **Session-level primitive.** Transfer/escalation is a session lifecycle
   event that the server orchestrates. The client receives a typed event and
   can react (reconnect to new agent, show hold UI, open a ticket link).
3. **Works in both self-hosted and platform modes.** The SDK defines the
   primitives; routing logic lives in user code (self-hosted) or the platform
   orchestrator.
4. **Composable with middleware.** Middleware can intercept, log, or block
   escalation attempts.

## Architecture

### New Concepts

#### `EscalationTarget`

A discriminated union describing where the conversation should go:

```ts
type EscalationTarget =
  | { type: "agent"; agent: string; instructions?: string }
  | { type: "human"; queue?: string; metadata?: Record<string, unknown> }
  | { type: "external"; url: string; metadata?: Record<string, unknown> };
```

- **`agent`** — Transfer to another defined agent by name. The server loads the
  target agent, seeds it with conversation history + optional transfer
  instructions, and reconnects the S2S session.
- **`human`** — Escalate to a human operator queue. The server emits an
  escalation event to the client with queue/metadata. The client is responsible
  for connecting the user to the human channel (e.g., phone transfer, live chat
  widget, support ticket).
- **`external`** — Hand off to an external system via webhook URL. The server
  POSTs conversation context to the URL and emits a confirmation event to the
  client.

#### `EscalationResult`

Returned to the LLM after escalation is initiated:

```ts
type EscalationResult = {
  status: "transferred" | "queued" | "failed";
  message: string;
  /** For human handoff: estimated wait, ticket ID, etc. */
  metadata?: Record<string, unknown>;
};
```

### Wire Protocol Changes

Add two new `ClientEvent` types:

```ts
// Server → Client
| {
    type: "escalation";
    target: EscalationTarget;
    reason: string;
    context: {
      sessionId: string;
      messages: WireMessage[];
      state?: Record<string, unknown>;
    };
  }
| {
    type: "transfer_complete";
    agent: string;  // new agent name (for agent-to-agent transfer)
  }
```

The `escalation` event tells the client *what's happening* so it can render
appropriate UI (loading spinner, "connecting you to a human agent", queue
position). For agent-to-agent transfers, `transfer_complete` signals that the
new agent is ready and the conversation can continue.

### SDK Surface

#### 1. Built-in `escalate` tool

Added to `BuiltinTool` union:

```ts
type BuiltinTool = ... | "escalate";
```

The tool is LLM-callable with parameters:

```ts
z.object({
  target: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("agent"),
      agent: z.string(),
      instructions: z.string().optional(),
    }),
    z.object({
      type: z.literal("human"),
      queue: z.string().optional(),
      metadata: z.record(z.unknown()).optional(),
    }),
    z.object({
      type: z.literal("external"),
      url: z.string().url(),
      metadata: z.record(z.unknown()).optional(),
    }),
  ]),
  reason: z.string().describe("Why the escalation is needed"),
  summary: z.string().describe("Brief summary of conversation so far"),
})
```

The LLM decides when to call this based on instructions. Agent authors
configure allowed targets and escalation policy in agent options.

#### 2. `AgentOptions.escalation` config

```ts
type EscalationConfig = {
  /** Allowed escalation targets. If not set, all targets are blocked. */
  targets?: EscalationTarget[];
  /**
   * Called when escalation is requested. Return the result or throw to block.
   * This is the main integration point for custom routing logic.
   */
  onEscalation?: (
    target: EscalationTarget,
    reason: string,
    summary: string,
    ctx: HookContext<S>,
  ) => EscalationResult | Promise<EscalationResult>;
};
```

Added to `AgentOptions`:

```ts
type AgentOptions<S> = {
  // ... existing fields ...
  escalation?: EscalationConfig;
};
```

#### 3. Middleware hook

Add `beforeEscalation` to `Middleware`:

```ts
type Middleware<S> = {
  // ... existing hooks ...
  /** Intercept escalation before it executes. Can block or transform. */
  beforeEscalation?: (
    target: EscalationTarget,
    reason: string,
    ctx: HookContext<S>,
  ) => { block: true; reason: string } | undefined | Promise<{ block: true; reason: string } | undefined>;
};
```

This lets guardrail middleware prevent unauthorized escalations (e.g., block
transfer to agents the user shouldn't access, rate-limit human escalations).

### Implementation Flow

#### Agent-to-Agent Transfer

```
LLM calls escalate({ target: { type: "agent", agent: "specialist" }, reason: "..." })
  │
  ▼
beforeEscalation middleware (can block)
  │
  ▼
Validate target agent exists in allowed targets
  │
  ▼
Call onEscalation hook (user routing logic)
  │
  ▼
Emit "escalation" event to client
  │
  ▼
Server-side:
  1. Serialize current conversation messages + transfer summary
  2. Stop current S2S session
  3. Load target agent config
  4. Create new S2S session with target agent
  5. Seed history: previous messages + system message with transfer context
  6. Emit "transfer_complete" to client
  7. New agent speaks greeting or acknowledgment
  │
  ▼
Return EscalationResult to LLM (though session has already switched)
```

#### Human Handoff

```
LLM calls escalate({ target: { type: "human", queue: "tier2" }, reason: "..." })
  │
  ▼
beforeEscalation middleware
  │
  ▼
Validate "human" target is allowed
  │
  ▼
Call onEscalation hook — user implements:
  - Create support ticket via API
  - Enqueue in phone system (Twilio, etc.)
  - Post to Slack channel
  - Return ticket ID / queue position
  │
  ▼
Emit "escalation" event to client with metadata (ticket ID, wait time, etc.)
  │
  ▼
Return EscalationResult to LLM
  │
  ▼
LLM speaks: "I've connected you with a human agent. Your ticket number is..."
  │
  ▼
Session can either:
  a) Stay open (agent provides comfort messages while waiting)
  b) Close gracefully with follow-up instructions
```

#### External Webhook Handoff

```
LLM calls escalate({ target: { type: "external", url: "https://..." }, reason: "..." })
  │
  ▼
beforeEscalation middleware
  │
  ▼
Validate URL is in allowed targets
  │
  ▼
POST conversation context to URL (via SSRF-safe fetch)
  │
  ▼
Call onEscalation with response
  │
  ▼
Emit "escalation" event to client
  │
  ▼
Return result to LLM
```

### Client-Side (aai-ui)

Add event handling for escalation events:

```ts
// New hook in session.ts
useEscalation((event) => {
  if (event.target.type === "human") {
    showHumanHandoffUI(event.context, event.target.metadata);
  } else if (event.target.type === "agent") {
    showTransferUI(event.target.agent);
  }
});
```

For agent-to-agent transfers, the client WebSocket stays open — the server
swaps the backend session. No client reconnection needed.

## File Changes

| File | Change |
|------|--------|
| `packages/aai/types.ts` | Add `EscalationTarget`, `EscalationResult`, `EscalationConfig` types. Add `escalation` to `AgentOptions` and `AgentDef`. Add `"escalate"` to `BuiltinTool`. Add `beforeEscalation` to `Middleware`. |
| `packages/aai/protocol.ts` | Add `escalation` and `transfer_complete` to `ClientEventSchema`. |
| `packages/aai/builtin-tools.ts` | Implement the `escalate` built-in tool. |
| `packages/aai/session.ts` | Handle escalation tool result: emit events, orchestrate agent-to-agent transfer (stop S2S, reload agent, start new S2S with history). |
| `packages/aai/middleware-core.ts` | Add `runBeforeEscalation` pipeline runner. |
| `packages/aai/middleware.ts` | Re-export `beforeEscalation` runner. |
| `packages/aai/internal-types.ts` | Add escalation fields to `AgentConfig` (serialized config sent to isolate). |
| `packages/aai-server/src/_harness-runtime.ts` | Forward escalation hook calls from isolate to host via RPC. |
| `packages/aai-server/src/_harness-protocol.ts` | Add escalation RPC types. |
| `packages/aai-server/src/sandbox.ts` | Handle escalation RPC from isolate, execute on host side. |
| `packages/aai-ui/session.ts` | Add `onEscalation` callback to session options. Dispatch escalation events. |
| `packages/aai-ui/index.ts` | Add `useEscalation` hook for Preact UI. |
| `packages/aai/types_test.ts` | Test `defineAgent` with escalation config. |
| `packages/aai/builtin-tools_test.ts` | Test escalate tool validation, middleware interception. |
| `packages/aai/session_test.ts` | Test agent-to-agent transfer flow, human handoff flow. |
| `packages/aai-cli/templates/_shared/CLAUDE.md` | Document escalation API for agent authors. |

## Implementation Order

- [ ] **Phase 1: Types & Protocol** — Add all types to `types.ts`, protocol
  events to `protocol.ts`, update schemas. This is the foundation everything
  else builds on.
- [ ] **Phase 2: Built-in tool** — Implement `escalate` in `builtin-tools.ts`
  with parameter validation and target allow-list checking.
- [ ] **Phase 3: Middleware** — Add `beforeEscalation` to middleware pipeline
  in `middleware-core.ts`.
- [ ] **Phase 4: Session orchestration** — Implement agent-to-agent transfer
  in `session.ts` (stop current S2S, swap agent config, start new S2S with
  seeded history). Implement human/external handoff event emission.
- [ ] **Phase 5: Platform support** — Wire escalation through the sandbox
  RPC boundary (`_harness-runtime.ts`, `_harness-protocol.ts`, `sandbox.ts`).
- [ ] **Phase 6: Client SDK** — Add `onEscalation` to `aai-ui` session and
  `useEscalation` hook.
- [ ] **Phase 7: Tests** — Unit tests for tool, middleware, session
  orchestration. Integration tests for full transfer flow.
- [ ] **Phase 8: Template & docs** — Add escalation example to templates,
  update `_shared/CLAUDE.md`.

## Example Usage

### Customer Service Agent with Human Handoff

```ts
import { defineAgent } from "aai";

export default defineAgent({
  name: "support-bot",
  instructions: `You are a customer support agent for Acme Corp.
    Help users with common questions. If the user is frustrated,
    asks for a manager, or you cannot resolve their issue after
    2 attempts, escalate to a human agent.`,
  builtinTools: ["escalate"],
  escalation: {
    targets: [
      { type: "human", queue: "tier1" },
      { type: "human", queue: "tier2" },
      { type: "agent", agent: "billing-specialist" },
    ],
    onEscalation: async (target, reason, summary, ctx) => {
      if (target.type === "human") {
        const ticket = await createZendeskTicket({
          queue: target.queue,
          reason,
          summary,
          sessionId: ctx.sessionId,
        });
        return {
          status: "queued",
          message: `Ticket ${ticket.id} created`,
          metadata: { ticketId: ticket.id, estimatedWait: "3 minutes" },
        };
      }
      // Agent-to-agent transfer handled automatically by the SDK
      return { status: "transferred", message: "Transferring now" };
    },
  },
});
```

### Multi-Agent System with Triage

```ts
import { defineAgent } from "aai";

export default defineAgent({
  name: "triage",
  instructions: `You are a medical triage assistant. Assess symptoms
    and route to the appropriate specialist. For emergencies,
    escalate to a human nurse immediately.`,
  builtinTools: ["escalate"],
  escalation: {
    targets: [
      { type: "agent", agent: "cardiology-agent" },
      { type: "agent", agent: "dermatology-agent" },
      { type: "agent", agent: "general-practice-agent" },
      { type: "human", queue: "nurse-line" },
    ],
    onEscalation: async (target, reason, summary, ctx) => {
      // Log all escalations for compliance
      await ctx.kv.set(`escalation:${ctx.sessionId}`, JSON.stringify({
        target, reason, summary, timestamp: Date.now(),
      }));
      return { status: "transferred", message: "Routing you now" };
    },
  },
  middleware: [{
    name: "escalation-guardrail",
    beforeEscalation: (target, reason) => {
      // Block direct-to-specialist without triage assessment
      if (target.type === "agent" && !reason.includes("assessed")) {
        return { block: true, reason: "Must complete triage assessment first" };
      }
    },
  }],
});
```

## Open Questions

1. **Agent registry for agent-to-agent transfer.** In self-hosted mode, how
   does the server know about other agents? Options:
   - (a) Multi-agent `createServer({ agents: [triageAgent, billingAgent] })`
   - (b) Agent registry callback `resolveAgent: (name) => AgentDef`
   - (c) Both — static list + dynamic resolver as fallback
   - **Recommendation**: (c). The static list covers 80% of cases. The
     resolver handles dynamic agent loading.

2. **Conversation history transfer.** How much history to seed into the
   target agent?
   - Full history (all messages) — most context but may confuse target agent
   - Summary only (from the `summary` param) — compact but lossy
   - **Recommendation**: Both. Send full history as messages + prepend a
     system message with the transfer summary and reason.

3. **Session state transfer.** Should the target agent receive the source
   agent's `state`?
   - No — agents have different state shapes, this would be a type error
   - **Recommendation**: No direct state transfer. Use KV store for any
     cross-agent shared state. The `onEscalation` hook can persist relevant
     state to KV before transfer.

4. **Return-to-original-agent.** Should there be a "transfer back" primitive?
   - Could be modeled as another escalation from the target agent back to
     the source
   - **Recommendation**: Yes, but defer to Phase 2. For now, any agent can
     escalate to any allowed target, including the original.
