---
"aai-server": patch
---

Align the platform server's keep-alive with the guest's client. serve({fetch,port}) set no keepAliveTimeout, so the server reaped idle sockets at Node's 5s default while the guest's egress pool holds its end for 30s - and the shorter side decides, so the client's value was unreachable and every journal call more than 5s after the previous one opened a fresh socket. A durable step taking longer than 5s is the ordinary case, so the guest-to-platform journal path paid that on essentially every appendStep. Measured on a real server with the guest's real client keep-alive: 5 POSTs 6s apart cost 5 TCP connections before and 1 after. The server's value is now DERIVED from EGRESS_KEEP_ALIVE_MS (newly exported on aai-runtime/internal) rather than restated, because the two being set independently in different packages is the defect; headersTimeout sits above it, since Node races the two.
