---
"aai-server": patch
---

Autoscale the Modal web service: target/max input concurrency with min/max/buffer container bounds, coupled to the server's per-replica MAX_CONNECTIONS websocket cap so Modal scales out before any replica starts refusing upgrades.
