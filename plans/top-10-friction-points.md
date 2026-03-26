# Top 10 SDK Friction Points — Condorcet Voting Results

**Status**: complete
**Method**: 10 simulated engineers x 3 voice agents each = 30 agents built. 134 raw friction points deduplicated to 42 canonical items. Each engineer ranked their top 15. Condorcet pairwise comparison (Copeland method) produced the final ranking.

---

## Final Top 10 (by Condorcet rank)

### #1 — Session state is ephemeral with no cross-session persistence
**ID**: F1 | **Copeland**: 32.0 | **Pairwise**: 32W-0L-0T (Condorcet winner)
**Raised by**: Sarah, Marcus, Priya, David, Alex, Chen, Elena, Jordan, Kai, Olivia (all 10)

Session state created by the `state: () => ({})` factory lives only in memory and is lost when the WebSocket disconnects or the server restarts. The KV store exists but there is no built-in pattern for hydrating session state from KV on reconnect, forcing every developer to build their own session recovery logic in `onConnect`/`onDisconnect`. This affects every domain — healthcare patient context, gaming progress, financial transaction state, IoT device configurations.

---

### #2 — No confirmation flow primitive for irreversible actions
**ID**: F13 | **Copeland**: 30.5 | **Pairwise**: 30W-1L-1T
**Raised by**: Sarah, Marcus, Priya, David, Alex, Chen, Elena, Jordan, Kai

There is no SDK-level confirmation pattern for destructive or irreversible operations like financial transactions, data deletion, or device commands. Developers must build ad-hoc confirmation flows using state flags and LLM instructions with no guarantee of compliance. Without idempotency keys, retries can cause duplicate side effects (e.g., double-charging).

---

### #3 — KV store lacks atomic operations, querying, and has restrictive size limits
**ID**: F14 | **Copeland**: 29.5 | **Pairwise**: 29W-2L-1T
**Raised by**: Sarah, Marcus, Priya, David, Chen, Elena, Olivia

The KV store supports only basic `get`/`set`/`list-by-prefix` with no atomic increment, compare-and-set, transactions, or query-by-value capability. The 64KB value size limit is too small for clinical records, analytical payloads, and enterprise data. There is no watch/subscribe for reactive updates, and no guidance on concurrent access patterns.

---

### #4 — No user authentication, identity, or role-based access control
**ID**: F4 | **Copeland**: 28.5 | **Pairwise**: 27W-2L-3T
**Raised by**: Marcus, David, Elena, Jordan, Sarah, Priya, Chen, Kai, Olivia

There is no user identity concept beyond `sessionId`. No support for OAuth, SSO, speaker verification, or per-user authentication. Without identity, there is no way to implement role-based tool gating, multi-tenant access policies, or compliance-grade user attribution.

---

### #5 — No conversation flow, dialog management, or state machine primitives
**ID**: F30 | **Copeland**: 28.0 | **Pairwise**: 28W-4L-0T
**Raised by**: Sarah, Marcus, Priya, David, Alex, Chen, Elena, Jordan, Kai, Olivia (all 10)

There is no built-in abstraction for managing multi-step conversation flows, form-filling sequences, or dialog state machines. Every developer must build ad-hoc flow management using `onBeforeStep` and state flags, leading to fragile agent logic for common patterns like appointment booking, onboarding, or data collection.

---

### #6 — No scheduled tasks, background timers, or push notifications
**ID**: F2 | **Copeland**: 27.5 | **Pairwise**: 27W-4L-1T
**Raised by**: Sarah, Marcus, Priya, David, Alex, Chen, Elena, Jordan, Kai, Olivia (all 10)

The SDK is purely request-response with no mechanism for agent-initiated actions. There is no cron, timer, or background task support, which blocks use cases like medication reminders, appointment notifications, trivia game timers, IoT sensor polling, and async workflow callbacks. Webhook and outbound notification support is also absent.

---

### #7 — No agent transfer, escalation, or human handoff mechanism
**ID**: F15 | **Copeland**: 26.5 | **Pairwise**: 26W-5L-1T
**Raised by**: Sarah, Marcus, David, Chen, Elena, Jordan, Kai

There is no primitive for transferring a conversation to another agent or escalating to a human operator. This is a baseline requirement for customer service, healthcare triage, and enterprise support workflows where the voice agent must gracefully hand off when it reaches its capability boundary.

---

### #8 — No retry, circuit breaker, or resilience patterns for tool failures
**ID**: F17 | **Copeland**: 25.0 | **Pairwise**: 25W-7L-0T
**Raised by**: Sarah, David, Chen, Marcus, Alex, Elena, Jordan, Kai, Olivia

There are no built-in resilience patterns for tool execution failures. No retry with backoff, no circuit breaker for flaky external APIs, no structured error taxonomy distinguishing retriable from permanent failures, and no standard error codes for tool results.

---

### #9 — No TTS voice, speech rate, language, or pacing configuration
**ID**: F7 | **Copeland**: 23.5 | **Pairwise**: 23W-8L-1T
**Raised by**: Marcus, Priya, Alex, Jordan, Sarah, Chen, Kai

The agent definition has no fields for TTS voice selection, speech rate, language, pronunciation hints, or pacing control. This blocks accessibility needs (adjustable speed), healthcare use cases (guided breathing), education (pronunciation practice), and basic personalization of the agent voice persona.

---

### #10 — No audit logging or compliance trail support
**ID**: F5 | **Copeland**: 21.5 | **Pairwise**: 19W-8L-5T
**Raised by**: Marcus, David, Elena, Olivia

No structured audit log facility or compliance hook exists in the SDK. Healthcare (HIPAA), finance (SOX/PCI), and enterprise customers (SOC2) all need immutable, structured records of agent interactions, tool invocations, and data access for regulatory compliance. The middleware hooks can intercept events but provide no guaranteed persistence or tamper-evident logging.

---

## Methodology

### Engineers and Agents Built

| # | Engineer | Focus | Agents |
|---|---------|-------|--------|
| 1 | Sarah | Restaurant/Retail | Restaurant Order, Retail Customer Service, Loyalty Program |
| 2 | Marcus | Healthcare | Symptom Checker, Medication Reminder, Mental Wellness |
| 3 | Priya | Education | Language Tutor, Math Helper, Study Quiz |
| 4 | David | Enterprise/B2B | IT Helpdesk, Sales Assistant, HR Onboarding |
| 5 | Alex | Gaming | Interactive Story, Trivia Game, Music DJ |
| 6 | Chen | IoT/Smart Home | Home Controller, Energy Monitor, Security System |
| 7 | Elena | Finance | Banking, Investment Advisor, Insurance Claims |
| 8 | Jordan | Accessibility | Screen Reader, Speech Therapy, Daily Living |
| 9 | Kai | Startup | Customer Onboarding, Feedback Collection, Booking |
| 10 | Olivia | Data/Analytics | BI Agent, Pipeline Monitor, Report Generator |

### Voting Process

- Each engineer identified 10-15 friction points from building their 3 agents
- 134 raw friction points were deduplicated into 42 canonical items
- Each engineer ranked their top 15 from the 42 canonical items
- Condorcet pairwise comparison (Copeland scoring) determined final ranking
- F1 is the true Condorcet winner (beats every other candidate head-to-head)

### Near Misses (#11-15)

| Rank | ID | Title | Score |
|------|-----|-------|-------|
| 11 | F21 | No concurrent/parallel tool execution | 21.0 |
| 12 | F33 | No conversation transcript export | 21.0 |
| 13 | F12 | No numeric/currency formatting for voice | 20.5 |
| 14 | F3 | Test harness can't simulate LLM decisions | 19.5 |
| 15 | F23 | No STT confidence scores | 19.0 |
