---
"@alexkroman1/aai": major
---

Fix 79 correctness findings and 133 cleanups from a whole-repo review sweep. BREAKING: slot.get() and the slot reading half now return DeepReadonly<T> rather than a shallow Readonly<T>. freezeStorable already deep-froze the value on every write, so mutating one always threw at runtime; the type simply did not say so, which moved the failure from compile time to first call. Two shipped templates were mutating a frozen slot value on every invocation, and the stricter type surfaced 37 more sites across the template suite. A domain helper typed over the mutable shape will now fail to compile: type it over DeepReadonly<T> (exported from the root). slot.set() also stores a copy rather than freezing the caller's own object in place.
