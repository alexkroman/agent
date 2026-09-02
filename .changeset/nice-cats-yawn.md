---
"@alexkroman1/aai-ui": minor
---

Add `useRunKey()`: the opaque, storage-backed lookup key `useWorkflowSubmit({ key, recover: true })` needs, with the storage kind (`session`, the default, or `local`) left to the caller. Six templates had each minted their own; the key is now scoped to the page's URL, so two agents scaffolded from one template on a shared origin no longer recover each other's runs.
