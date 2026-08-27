---
"@alexkroman1/aai-runtime": minor
---

Add the live stream read: GET /:slug/workflow-stream on the platform and the guest client for readFromStream. The HTTP body IS the stream; the response is bounded so a stream whose run died cannot hold a connection forever, and the guest resumes with startIndex.
