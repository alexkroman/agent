# Scripts

## S2S Load Test

Drives realistic S2S voice sessions with TTS audio, tool calling, barge-in
simulation, connection retries, and network chaos via Toxiproxy.

### Prerequisites

```sh
brew install toxiproxy
```

The script automatically starts and stops `toxiproxy-server`.

### Usage

```sh
# Default launch-day simulation (5000 sessions, 2500 concurrent)
npx tsx scripts/s2s-load-test.ts

# Quick smoke test
npx tsx scripts/s2s-load-test.ts -n 2 -c 2 --rampMs 0 -v

# See all options
npx tsx scripts/s2s-load-test.ts --help
```

Requires `$ASSEMBLYAI_API_KEY` environment variable.

### Toxiproxy

Toxiproxy adds realistic network conditions to every session. Configurable via:

- `--toxicLatency` / `--toxicJitter` — added latency (default: 50ms +/- 20ms)
- `--toxicBandwidth` — bandwidth limit in KB/s (default: unlimited)
- `--toxicReset` — connection reset probability (default: 2.5%)

## Platform WebSocket Load Test

Drives end-to-end sessions against any AAI platform WebSocket URL
(`wss://host/<slug>/websocket`). Measures connect latency, first-audio turn
latency (p50/p95/p99), tool-call counts, and error distribution. Uses the
same Kokoro TTS audio generation and worker-pool approach as the S2S test;
no Toxiproxy dependency.

### Usage

```sh
# Quick smoke test (1 session, verbose)
npx tsx scripts/platform-ws-load-test.ts --url wss://my-host/my-agent/websocket -n 1 -v

# Sustained load (100 sessions, 25 concurrent)
npx tsx scripts/platform-ws-load-test.ts --url wss://my-host/my-agent/websocket -n 100 -c 25

# See all options
npx tsx scripts/platform-ws-load-test.ts --help
```

No environment variables required (API key is handled by the platform, not the load test).
