---
"@alexkroman1/aai": patch
---

The default prompt's lookup-recovery ladder now handles a spelling that is
itself mis-heard. Once a spelled value has failed, the agent asks for each
letter with a word ("S as in Sam, F as in Frank") and sends only the letters,
because letter names like S/F and M/N sound alike over a voice line. The
letter-confusion retry also swaps every copy of a confused letter at once. On a
tau2 retail call the caller spelled S-S three times, was transcribed F-F each
time, and the agent transferred after six failed lookups. This is not yet
measured by replay.
