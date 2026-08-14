---
"@alexkroman1/aai": patch
---

Stop the workflow HTTP API answering 400 with raw internal errors. `POST /workflows/runs` and `GET /workflows/runs` wrapped their whole engine call in a catch that returned the error text at 400, so a database outage answered a form submission with the connection string (`connect ECONNREFUSED host:port`) and a run listing with its full SQL statement — on a surface that is unauthenticated unless AAI_WORKFLOW_API_TOKEN is set, and with a status that tells clients not to retry. Caller mistakes (an unknown workflow name, input failing the schema) now throw a distinct type and keep their 400 and their message; everything else reaches the router, which logs the cause and answers an opaque 500.
