# Scaffold CLAUDE.md Optimization

## Problem

The scaffold CLAUDE.md (installed into every agent project) has grown to
1359 lines over time. While it generally produces good agents, the content
is interleaved — actionable guidance mixed with API reference — making it
harder for Claude Code to find what it needs. Several common patterns
(error handling, debugging, multi-turn tools) are undocumented.

## Goal

Reorganize the existing (proven) content into a clear hierarchy and fill
documented gaps, so Claude Code produces better agents with less friction.

## Approach

Reorganize + fill gaps. Keep existing content that works, restructure into
actionable-first / reference-second hierarchy, add missing patterns. Minimal
cuts — only deduplicate truly redundant content.

## New Information Hierarchy

```
1. INTRO & WORKFLOW
   - One-paragraph overview
   - 5-step workflow
   - 7 key rules

2. QUICKSTART
   - Minimal agent example (moved up from line 76)
   - CLI commands
   - Directory structure

3. CORE FEATURES
   - agent.json format
   - Writing good systemPrompts
   - Tools (custom + built-in + context API + error handling [NEW])
   - Hooks (lifecycle + execution order [NEW])
   - Secrets & environment variables
   - Persistent storage (KV + naming conventions [NEW] + limits)

4. CUSTOM UI (optional)
   - client.tsx basics + Preact/signals rules
   - Built-in components
   - Data flow (tool results → UI)
   - Styling (Tailwind v4, consolidated)

5. TESTING (moved up from line 1163)
   - Test harness API
   - Multi-turn testing patterns
   - Common assertion patterns

6. ADVANCED (appendix)
   - toolChoice & maxSteps tuning
   - Conversation history access
   - Embedded knowledge
   - Debugging agents [NEW]
   - Self-hosting (moved here)
   - Headless sessions (moved here)
   - Tool return filtering [NEW]

7. COMMON PITFALLS

8. REFERENCE TABLES (appendix)
   - Session API signals/methods
   - Design tokens
```

## New Content to Add (~90 lines)

### Error handling in tools (~20 lines)
- Try-catch pattern in tool execute functions
- What happens when a tool throws (error goes to LLM, LLM can retry)
- Example: HTTP fetch returning user-friendly error

### Multi-turn tool patterns (~15 lines)
- Tool reading state set by a previous tool via KV
- Tools should be independent but share state through KV

### KV naming conventions (~15 lines)
- Colon-separated keys: `user:profile`, `order:items`
- Index key pattern for listing
- Size limits: 64 KB per value

### Hook execution order (~10 lines)
- on-connect → on-user-transcript → on-error → on-disconnect
- Hooks run sequentially

### Debugging agents (~20 lines)
- `aai dev` terminal shows tool calls and LLM responses
- Common flow: check terminal → verify tool returns → check KV
- console.log in tools visible in dev mode

### Tool return filtering (~10 lines)
- LLM context has token limits
- Extract only needed fields from API responses
- Example: weather API → return `{ temp, conditions }` only

## Content to Remove or Consolidate (~70 lines)

- **Remove**: "Useful free API endpoints" list (~25 lines) — goes stale,
  Claude Code finds APIs on its own
- **Deduplicate**: Theme/styling config (~15 lines) — consolidate into
  Styling section only
- **Move to appendix**: Self-hosting and headless session details (~20
  lines) — alternative paths that interrupt main flow
- **Deduplicate**: KV type signatures (~10 lines) — keep standalone
  section, cross-reference from tool/hook context

## Net Effect

~70 lines removed/moved + ~90 lines added = roughly same total length,
significantly better organized.
