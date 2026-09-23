---
"@alexkroman1/aai-runtime": major
"@alexkroman1/aai-ui": major
---

Seal the handles a caller receives, and give the newest features their own subpaths and capabilities.

- **`Runtime` and `BrowserSession` are sealed.** Each carries a type-only brand (`runtimeBrand`, `browserSessionBrand`), so only `createRuntime` / `createBrowserSession` produce one and either can grow a member without breaking a hand-written double. A server-spec double implements `SessionRuntime`.
- **`runtime.connect(sink, options)` is now `connectSession(runtime, sink, options)`**, a free function on `@alexkroman1/aai-runtime`.
- **Push-to-talk is a sub-handle:** `session.startUserTurn()` / `commitUserTurn()` / `clearUserTurn()` are `session.userTurn.start()` / `.commit()` / `.clear()` (`UserTurnControls`), reached from React through `usePushToTalk`. `SessionActions` is declared on its own and no longer carries them. `usePushToTalk` is its own `push-to-talk` capability.
- **Session tickets moved to `@alexkroman1/aai-runtime/auth`.** `createSessionToken`, `verifySessionToken`, `SESSION_SECRET_ENV`, `SESSION_AUTH_PROTOCOL_PREFIX`, `SESSION_UNAUTHORIZED_CLOSE_CODE` and the ticket types left the root barrel, and a server's `auth` option now takes `createSessionAuth({ secret, verify, allowedOrigins })` instead of an options literal.
- **Metric sinks moved to `@alexkroman1/aai-runtime/metrics`**: `registerMetricsSink`, `otelMetricsSink`, `OtelMeterLike`, `MetricsSink`, `MetricsContext`, `OTEL_METRIC_NAMES`, `metricsEndpoint` and the `OTEL_METRICS_*` constants are no longer on `/tracing`. `startTracing` still arms metric export.
- **Simulated callers and the judge moved to `@alexkroman1/aai-runtime/eval/simulate`.** `simulateCall`, `judgeCall` and their types left `/eval`; a `describeEval` / `describeTextEval` case no longer receives `simulate()` / `judge()`, and `stubCaller` / `stubJudge` / `callerLlm` / `judgeLlm` left the case and suite options — build the pair with `evalSimulation({ agent, mode, target: session, stubCaller, stubJudge, callerLlm, judgeLlm })`.
- `AgentServerOptions` and `SharedServerOptions` declare their own field types (new `ServerUpgradeHook` / `ServerRequestHook`), and `RuntimeOptions.generate` (an internal eval seam) is no longer public.
