# Host server concurrency benchmark

How many simultaneous voice sessions one `createHostServer()` process holds,
measured rather than estimated.

```sh
node bench.mjs --steps 100,200,400,600,1000 --hold 12
```

## What it actually runs

Each simulated tenant does what a real one does: opens `?host=1`, deploys its
agent in the config frame, then streams 16 kHz PCM16 continuously and reads the
agent's audio back. Everything above the provider socket is real code — the
real handshake, a real per-connection runtime, the real pipeline transport and
audio pacer.

The two AssemblyAI providers are replaced by local fakes, reached through the
documented staging overrides (`assemblyAIStt({ streamingUrl })`,
`assemblyAITts({ host })`). Both speak TLS, because the vendor STT SDK refuses a
`ws://` endpoint outright and the TTS adapter hardcodes `wss://`. The fakes run
in the *driver* process, so their cost never lands in the measurement — which
also matches production, where the providers are somebody else's machines.

## Results — 4 vCPU, 16 GB, Node 22

Paced connects (25 every 250ms), 12s hold per step, 20ms audio frames.
`CPU%` is percent of **one** core; `drvCPU` is the load driver on the same box.

```text
  conns   ready  RSS MiB  KiB/conn   CPU%  drvCPU  loop lag  ready p50/p95   audio in
    100     100      179       638     14      13      15ms       54/223ms   3085KiB/s
    200     200      207       464     42      26      45ms       45/160ms   6165KiB/s
    300     300      236       410     38      39       7ms       39/149ms   9301KiB/s
    400     400      261       370     43      46      44ms       40/133ms  12407KiB/s
    600     600      320       347     67      72      29ms       42/194ms  18582KiB/s
    800     800      391       343     98      97      50ms       53/467ms  24407KiB/s
   1000    1000      460       345    104      99      59ms       68/743ms  30319KiB/s
```

**1000 concurrent streaming sessions, and the box was not the thing that
stopped it.** At 1000 the server holds 460 MiB, uses just over one core, keeps
event-loop lag under 60ms, and loses no audio: 30,319 KiB/s inbound against a
30,850 KiB/s theoretical maximum is 98.3%, and the shortfall is the driver
missing its own 50 Hz cadence, not the server dropping frames.

Marginal cost per session, from the 400→1000 slope: **~300 KiB RSS and ~0.1% of
a core.**

**Memory is not the constraint — the event loop is.** At 345 KiB/session, 16 GB
would hold roughly 45,000 sessions. One CPU core runs out at about 1,000.

Two failure modes show up past the clean region, from an earlier unpaced run
(`--steps 400,800,1200,1600`, all connects at once):

- **Connect bursts are much more expensive than steady state.** 400 sessions
  opening simultaneously pushed `ready p95` to 2.3s, versus 0.13s for the same
  400 opened in batches of 25. Each connect costs two TLS handshakes, and they
  all land on one event loop.
- **Past ~1200 it comes apart.** Event-loop lag hit 2.4s at 1200 and `ready p95`
  reached 21s at 1600, with STT connect attempts timing out at 2.5s — the
  server was too busy to finish its own outbound handshakes.

## Caveats — read before quoting these

- **The driver shares the machine.** It saturates a core at ~1000 sessions
  (`drvCPU` 99%), so 1000 is a floor on server capacity, not a ceiling. Testing
  beyond it needs load generated from another box.
- **No provider RTT.** The fakes are on loopback. Real STT/TTS sockets add WAN
  latency and jitter, which means more in-flight buffering per session.
- **No LLM, and no committed turns.** The fake STT emits partials but never sets
  `end_of_turn`, so no turn ever reaches the LLM. Real traffic pays for LLM
  streaming, tool relays, and TTS synthesis on every turn. Sessions here do
  speak their greeting, so the outbound TTS→client path is exercised, just not
  repeatedly.
- **Silence compresses well in the abstract but not here.** Frames are zeroed
  PCM; `permessage-deflate` is off on every socket (deliberately — see the SDK
  guide), so this costs nothing it would not cost with real audio.
- **This is a container on shared infrastructure**, not a dedicated VM. Treat
  the shape of the curve as more reliable than any single number.
