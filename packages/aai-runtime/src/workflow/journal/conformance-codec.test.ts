// Copyright 2026 the AAI authors. MIT license.
// The value encoding (typed JSON through every column) case list, run against the memory reference on its own.
//
// `conformance.test.ts` runs every list against every unit-tier arm through
// `journalConformance`; this file is the list's co-located claim, so a case
// that stops holding on the REFERENCE fails beside the module that states it.

import { createMemoryJournal } from "./backends/memory.ts";
import { type JournalArm, journalIds } from "./conformance-cases.ts";
import { journalCodecConformance } from "./conformance-codec.ts";

const store = createMemoryJournal();

const arm: JournalArm = {
  label: "memory (codec list)",
  // ONE store across every case, as every arm uses: a fresh one per case would
  // hide a case that leaks state.
  journal: () => store,
  uid: journalIds("mem-codec"),
  resumable: true,
};

journalCodecConformance(arm);
