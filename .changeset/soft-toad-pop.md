---
"@alexkroman1/aai-runtime": patch
---

A completed run's snapshot falls back to `WdkAdapter.readOutput` when the record carries no `output`, which is legal for an adapter written against a retained epoch. Such adapters silently reported `output: undefined` for every completed run.
