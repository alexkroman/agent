---
"@alexkroman1/aai-runtime": patch
---

A required string argument sent empty or as whitespace is now refused before the
call runs, like a missing one, unless the parameter says empty is a real answer
(its `enum` holds `""`, or its description names an empty value, as tau2's
`address2` does with "such as 'Apt 1' or ''"). On tau2 retail,
`find_user_id_by_email({ email: " " })` and `last_name: ""` went to the client
and came back "User not found".
