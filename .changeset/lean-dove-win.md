---
"aai-studio-server": patch
---

Studio API page: document how to actually SEND a file. The upload routes were in the route table and every generated run body carried an upload id, but the only worked example of obtaining one was buried in the SDK start snippet. There is now a "Sending a file" card — generated from the agent's own listing, rendered only when a declared workflow takes an upload — leading with the client SDK (agent.upload / agent.uploadStream / agent.uploadInfo) and covering both orders: send the file and get an id back, or mint the id, start the run, and stream the bytes into it. The curl alternates really upload, leaving the id in a shell variable the run body expands.
