---
---

Add a `microsandbox` sandbox backend: local dev now runs guests in a libkrun
microVM booted from the same OCI image production pulls, instead of as a child
process of the server with no isolation. `subprocess` stays, reachable by
naming it.
