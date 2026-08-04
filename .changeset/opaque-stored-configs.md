---
"@alexkroman1/aai": patch
---

Stored agent configs are now opaque to the platform server. Strict config
validation (`IsolateConfigSchema`) runs once, at deploy time, on the freshly
extracted config; row reads assert only the fields the host consumes (`name`,
`greeting`) and pass everything else through untouched. A future schema
tightening can therefore never make previously-deployed agents unreadable.
