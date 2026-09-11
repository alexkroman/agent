/**
 * What this store's callers say that a general recognizer has no reason to
 * expect — the `keyterms_prompt` this agent opens its STT stream with.
 *
 * A mis-heard entity is this template's worst failure and the one hardest to
 * see: "wireless earbuds" heard as "wireless ear buds" resolves to nothing,
 * "Bluetooth speaker" heard as "blue tooth speaker" resolves to nothing, and
 * the model then tells a caller their own order does not contain an item they
 * are holding. Nothing in the transcript looks wrong.
 *
 * ## Why the list is SHORT, and stays short
 *
 * AssemblyAI's guidance and Vapi's published keyword advice agree on three
 * rules, and all three point the same way:
 *
 * - **Uncommon words and proper nouns only.** "Laptop", "notebook", "grill"
 *   and "return" are all in this domain and none of them is here: a general
 *   model already recognizes them, and boosting a common word buys false
 *   positives on everything that sounds like it.
 * - **The exact spelling and casing you want in the transcript.** These are
 *   the strings the model is being asked to produce, so `"USB-C"` and
 *   `"usb c"` are different requests — and `resolve.ts`, which matches a
 *   spoken item against the account, is matching against whatever comes out.
 * - **Start small.** Over-boosting makes the model hear terms nobody said,
 *   which is the same failure pointed the other way. The cap is 100 terms;
 *   this is well under it deliberately, and the way to extend it is one term
 *   at a time against a transcript that got that term wrong.
 *
 * There are no ORDER IDS here, and there cannot be: they are per account
 * (`#W2378156`), they arrive one call at a time, and a hundred slots would
 * cover a rounding error's worth of them. The mechanisms that carry those are
 * the other two — `agent_context`, refreshed with the agent's own last reply
 * so the recognizer knows an order number was just asked for, and
 * `resolve.ts`'s spoken-identifier matching on the way back.
 */

/**
 * Multi-word product names whose halves are ordinary words.
 *
 * This is the shape of term keyterms are actually for: every word in
 * "electric kettle" is common, and the PAIR is what the recognizer splits,
 * mangles, or resolves to a near neighbour.
 */
const PRODUCTS = [
  "wireless earbuds",
  "mechanical keyboard",
  "espresso machine",
  "electric kettle",
  "smart thermostat",
  "air purifier",
  "portable charger",
  "indoor security camera",
  "vacuum cleaner",
  "patio umbrella",
  "hiking boots",
  "jigsaw puzzle",
  "luggage set",
  "dumbbell set",
  "yoga mat",
  "e-reader",
  "action camera",
  "Bluetooth speaker",
] as const;

/**
 * The option vocabulary a caller uses to pick a VARIANT.
 *
 * A variant is what an exchange turns on, so mis-hearing one is a wrong
 * `item_id` rather than a wrong word — the same class of failure as a mis-read
 * order number, arriving through the part of the sentence nobody watches.
 */
const OPTIONS = [
  "stainless steel",
  "matte black",
  "USB-C",
  "OLED",
  "1080p",
  "4K",
  "noise cancelling",
  "tactile switch",
  "linear switch",
] as const;

/**
 * The words this domain's PROCEDURE is conducted in.
 *
 * Every one of them decides which tool the model reaches for, so a swap
 * between two of them is a wrong action rather than a wrong noun: "exchange"
 * heard as "change" is a different tool, and "gift card" heard as "gift
 * certificate" sends a refund somewhere the account cannot receive it.
 */
const PROCEDURE = [
  "order number",
  "item number",
  "tracking number",
  "payment method",
  "original payment method",
  "gift card",
  "store credit",
  "PayPal",
  "exchange",
  "modify",
] as const;

/**
 * The list this agent's `assemblyAIStt({ keyterms })` sends.
 *
 * Assembled from the three groups above rather than written flat, because the
 * REASON a term is here is the only thing that makes the next edit a judgement
 * instead of a guess — a term nobody can place in one of these groups probably
 * should not be added.
 */
export const RETAIL_KEYTERMS: readonly string[] = [...PRODUCTS, ...OPTIONS, ...PROCEDURE];

/**
 * The names on this store's accounts — boosted ONLY while the call is
 * identifying its caller.
 *
 * Per state rather than per session, and the reason is the whole point of a
 * per-phase keyterm list: a personal name is the hardest thing on this call to
 * recognize and the least useful thing to boost afterwards. "Aarav" competes
 * with nothing once the caller is authenticated, and a permanently boosted
 * name list is a permanent source of false positives on every later turn — the
 * over-boosting AssemblyAI's own guidance warns about.
 *
 * Only the UNCOMMON ones are here. "Smith", "Brown" and "Anderson" are in this
 * store's seed too and are deliberately absent: a general model already
 * recognizes them, so a slot spent on one is a slot and a false positive.
 *
 * **A real deployment's list is longer than 100 and cannot be written here.**
 * The cap is 100 terms, so an account base of any size does not fit, and the
 * mechanism for it is not this one: an application that knows WHO is calling
 * (a CRM lookup on the inbound number) puts that in
 * `assemblyAIStt({ agentContext })`, which is free text and measured at −49%
 * entity error on names when it carries specifics. What a keyterm list is for
 * is the closed vocabulary a store has regardless of who calls.
 */
export const IDENTIFYING_KEYTERMS: readonly string[] = [
  // First names from `seed.json`, minus the ones a general model gets right.
  "Aarav",
  "Anya",
  "Harper",
  "Olivia",
  // Surnames, same rule.
  "Ito",
  "Garcia",
  "Gonzalez",
  // What the caller is being ASKED for in this phase, which is as much a part
  // of the phase's vocabulary as the answers are.
  "zip code",
  "email address",
];
