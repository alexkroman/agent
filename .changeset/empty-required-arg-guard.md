---
"@alexkroman1/aai-runtime": patch
---

A tool call that leaves a required text argument blank is no longer executed.
When the model calls a tool with a required string field set to `""`, to
whitespace only, or left out entirely (typically because the caller has not
given that value yet), the runtime answers the call with a tool failure
instead of running it:
`{"error":"\"postal_code\" is empty — ask the caller for it before calling find_user."}`.
The message names every blank field. The model reads this like any other
failed result and can ask for the value. The call's result is still recorded,
so every tool call keeps a paired result.

This applies to pipeline, text-agent, subagent and S2S tool calls. In host
(relay) mode the call is never sent to the client. The tool's own `messages`
are not spoken for a refused call. Only plain string-typed required fields are
checked. `null` is accepted for a nullable string. Optional fields, fields of
any other type, and fields with an `enum` or `const` are unaffected. Each
refused call logs `empty required argument; call not executed` with the tool
name and the fields.
