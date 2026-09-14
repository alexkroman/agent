---
"@alexkroman1/aai": minor
"@alexkroman1/aai-runtime": minor
---

`ctx.steerRecognizer(keyterms)` — bias the recognizer toward what a lookup just returned, for the rest of the call.

**The recognizer could be steered from two places, and both were decided before a call knew who was on it.** `assemblyAIStt({ keyterms })` is the DEPLOYMENT's vocabulary and a `dialog()` state's list is the PHASE's; neither can express the fact with the most value in it and the shortest life — *this caller is Yusuf Rossi, calling about order #W2378156* — because that is known only once a tool has looked it up. Measured on tau2-bench retail, that is the gap that mattered: order ids came through 41 renderings with a single digit substitution, while a caller's NAME collapsed repeatedly and fatally ("Yusuf" → "Yuta" → "Yufus", three failed lookups and a transfer to a human). Both sinks were already wired and pushed every turn; what was missing was a route from a tool body to either.

```ts
const user = await findUser(args);
ctx.steerRecognizer([user.firstName, user.lastName]);
```

**The PROVIDER merges the two lists, not the transport** — `SttSession.updateKeyterms(phase, session)`. `undefined` on the first argument means "restore the set the stream was opened with", and only an implementation holds that set, so a transport unioning anything onto it would need a second copy that could drift. **The session's terms go FIRST**, which is the load-bearing half of the decision: both lists share the service's 100-term cap and `normalizeKeyterms` trims from the end, so a deployment shipping a full vocabulary would otherwise drop the one term looked up FOR this caller.

**Nothing is pushed at call time.** The terms ride the push the transport already makes at the END of each agent turn — the moment steering is worth most, since the audio after a question is the answer to it, and the only place the two lists meet. The BUDGET lives in the accumulator (`transports/pipeline-session-keyterms.ts`): case-insensitive dedupe with the first spelling winning (so a term already on the wire is never rewritten for nothing), capped at `SESSION_KEYTERM_LIMIT` (25, a fraction of the service's own), and the OLDEST drops — refusing new terms once full would leave a long call permanently unable to learn the fact it is currently failing on.

**It answers `false` rather than throwing** when the hint went nowhere: a stopped session, or S2S, which runs recognition service-side and exposes no control over it. `ServerSession.steerRecognizer` mirrors `announce` exactly, for the same reason — a failed hint is never a reason to fail the tool that offered it. Every link in the chain is optional (`Transport.steerRecognizer?`, `SttSession.updateKeyterms?`, an executor option defaulting to a `false` stub), so a break anywhere would be a silent no-op; the end-to-end specs are A/B verified against exactly that.

`agentContext` is deliberately NOT reachable this way. It is overwritten every turn with the agent's own last reply, so a session-scoped value needs a composition rule deciding what to keep of each — a second design — and the vendor claim behind it (−21% WER over 20,000 calls) is one nobody here has reproduced. Keyterms is the sink the measurement points at.

`aai:tool` is epoch 6 and `aai-runtime:session` epoch 2, both RETAINING their predecessor: `ToolContext` and `ServerSession` are types their consumers RECEIVE (a tool body reads a context; a host gets a session from `Runtime.createSession`), so a required member is a widening for everyone who can reach them. Each frozen example states the boundary — code that CONSTRUCTS either one by hand is not covered, which is what the published `createToolContext` exists to spare an author.
