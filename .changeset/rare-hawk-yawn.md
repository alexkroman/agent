---
"@alexkroman1/aai": minor
---

BREAKING (testing API): fold routeStepFetch, StepRoute and StepUnmatched into stubFetchRoutes — pass it the list of legs (a model's stubGatewayRoute().route first), with the new globalFetch: false option to route only the step fetch. Remove installFetchRoutes (use stubFetchRoutes plus onTestFinished(net.restore)) and createProgressStream (use ReadableStream.from). commandedBuiltins is no longer exported; expectPromptBuiltinsDeclared returns the same list.
