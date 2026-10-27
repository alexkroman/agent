---
"@alexkroman1/aai": minor
"@alexkroman1/aai-runtime": minor
---

Two pipeline safeguards for tool-using voice agents.

A tool schema may declare `annotations: { readOnlyHint: false }` to mark it as a
write. The pipeline then runs it only on a caller turn that did not begin while
agent audio was playing (filler included); otherwise the model is told to ask
for confirmation and wait. On tau2 retail, three writes ran on a backchannel
spoken over the agent's question. Tools without the annotation are unchanged.

The proper nouns in tool results (names, products, cities) are now pushed to the
STT as keyterms for the rest of the call, through a new optional
`SttSession.updateKeyterms`, which AssemblyAI implements with `keyterms_prompt`.
On tau2 retail, "pet bed" was transcribed "MedBed" and "Rossi" as "Rafi" after
the agent had already looked both up.
