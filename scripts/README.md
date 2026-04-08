# Scripts

## S2S Load Test

Drives realistic S2S voice sessions with TTS audio, tool calling, barge-in
simulation, connection retries, and optional network chaos via Toxiproxy.

### Prerequisites

```sh
# Toxiproxy (optional, for network chaos simulation)
brew install toxiproxy
toxiproxy-server &   # start in background
```

### Usage

```sh
# Default launch-day simulation (5000 sessions, 2500 concurrent, toxiproxy on)
npx tsx scripts/s2s-load-test.ts

# Quick smoke test
npx tsx scripts/s2s-load-test.ts -n 2 -c 2 --rampMs 0 --no-toxiproxy -v

# Without network chaos
npx tsx scripts/s2s-load-test.ts --no-toxiproxy

# See all options
npx tsx scripts/s2s-load-test.ts --help
```

Requires `$ASSEMBLYAI_API_KEY` environment variable.

### Toxiproxy

When `--toxiproxy` is enabled (default), the script connects to a local
`toxiproxy-server` on port 8474 and creates a proxy with configurable
network conditions:

- `--toxicLatency` / `--toxicJitter` — added latency (default: 50ms +/- 20ms)
- `--toxicBandwidth` — bandwidth limit in KB/s (default: unlimited)
- `--toxicReset` — connection reset probability (default: 2.5%)

If the server isn't running, the script will error with install instructions.
