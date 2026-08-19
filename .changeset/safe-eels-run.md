---
"@alexkroman1/aai": minor
---

Add an opt-in parallel upload: the browser can split a file into parts and send them at once. `api.upload(file, { parallel: true })`, `useWorkflowSubmit(w, { parallel })` and `useWorkflowStream(w, { parallel })` cut the file into megabyte-aligned windows and fan them out over the new `POST|PUT /workflows/uploads/:id/parts` routes; the store publishes the contiguous prefix as `size`, so readers and the streaming flow are unchanged. Falls back to the single request for a small file, an uncuttable body, or an agent that does not serve the routes.
