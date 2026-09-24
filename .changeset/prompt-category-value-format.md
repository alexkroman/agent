---
"@alexkroman1/aai": patch
---

`DEFAULT_SYSTEM_PROMPT`'s TOOLS section gains a last bullet: when a tool parameter names a type, category, mode, or key rather than taking free text, the model sends the category the caller named in the parameter's value format (lowercase, underscores for spaces, no possessives — "a gift card" becomes `gift_card`), and treats a schema example as a format, not a menu to pick from. Voice callers name categories in speech, and the model was copying the spoken phrase into code-like parameters. In offline replay on the SDK's own prompt assembly (N=10), spoken-form values fell from 5/10 to 0-1/10; a wording without the "not a menu" clause made the model substitute the schema's example value 4/10, and this wording 0-1/10. Affects every agent that uses the default prompt and has tools; no export or signature changed.
