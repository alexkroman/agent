# Dialog Management & Flow Primitives

**Status**: in-progress
**Issue**: F30 (Copeland 28.0, Pairwise 28W-4L-0T)
**Raised by**: All 10 reviewers

## Problem

No built-in abstraction for multi-step conversation flows, form-filling, or
dialog state machines. Developers build ad-hoc flow management with
`onBeforeStep` and state flags → fragile logic for common patterns like
appointment booking, onboarding, data collection.

## Design

### API: `defineFlow`

A declarative state machine that composes into `defineAgent` via middleware
and the existing `state` factory. Zero new runtime dependencies.

```ts
import { defineFlow } from "@alexkroman1/aai/flow";

const flow = defineFlow({
  initial: "greeting",
  steps: {
    greeting: {
      instructions: "Greet the user and ask what service they need.",
      activeTools: ["lookup_services"],
      on: { SERVICE_SELECTED: "collect_info" },
    },
    collect_info: {
      instructions: "Collect name, phone, and preferred date/time.",
      activeTools: ["check_availability", "save_info"],
      on: { INFO_COMPLETE: "confirm" },
    },
    confirm: {
      instructions: "Read back booking details and ask for confirmation.",
      activeTools: ["create_booking"],
      on: { CONFIRMED: "done", RESTART: "greeting" },
    },
    done: {
      instructions: "Booking confirmed. Thank the user.",
      terminal: true,
    },
  },
});
```

### Integration with `defineAgent`

```ts
defineAgent({
  name: "Booking Agent",
  instructions: "You are a booking assistant. Follow the dialog step instructions.",
  state: () => ({ ...flow.initialState(), name: "", phone: "" }),
  middleware: [flow.middleware()],
  tools: {
    save_info: defineTool({
      description: "Save collected info",
      parameters: z.object({ name: z.string(), phone: z.string() }),
      execute: (args, ctx) => {
        ctx.state.name = args.name;
        flow.transition(ctx, "INFO_COMPLETE");
        return "Info saved.";
      },
    }),
  },
});
```

### How It Works

1. **State tracking**: `flow.initialState()` returns `{ __flow: "greeting" }`
   merged into session state.
2. **Instruction injection**: Middleware `beforeInput` prepends current step's
   instructions to each user message so the LLM sees them.
3. **Tool gating**: Middleware `beforeToolCall` blocks tools not listed in the
   current step's `activeTools`. The LLM gets a reason message.
4. **Transitions**: Tools call `flow.transition(ctx, "EVENT")` to advance.
   The flow validates the event exists for the current step.

### Design Decisions

- **Middleware-only** — no new hooks or agent-level options needed. Composes
  with existing middleware, `onBeforeStep`, and `state`.
- **Explicit transitions** — tools trigger transitions, not implicit conditions.
  This is simpler, debuggable, and works well with voice (no form validation
  needed — the LLM handles conversational collection).
- **No `onEnter`/`onExit` hooks** in v1 — tools handle side effects. Can add
  later if needed.
- **Type-safe step names** — `defineFlow` infers step names as a union type,
  so `on` transitions are checked at compile time.

### Files

| File | Action |
|------|--------|
| `packages/aai/flow.ts` | New — `defineFlow`, types, middleware factory |
| `packages/aai/flow_test.ts` | New — unit tests |
| `packages/aai/package.json` | Add `./flow` export |
| `packages/aai/index.ts` | Re-export `defineFlow` + types |

### Future Extensions (out of scope for v1)

- `onEnter` / `onExit` step hooks
- Guard conditions on transitions
- Parallel/nested flows
- `defineForm` higher-level abstraction for structured data collection
- Flow visualization/debugging tools
