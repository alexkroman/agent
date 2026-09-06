/**
 * Their `policies/*.md`: a progressive-disclosure knowledge base, one topic per
 * entry, whose first line is the index the model reads in the tool's description
 * and whose body is what it receives on lookup.
 *
 * The receptionist's prompt keeps only the hot-path facts inline; everything
 * long-tail is here, and `lookup_policy` is the one way to reach it. Four topics
 * are RENDERED from `catalogs.ts` rather than written — their files carried a
 * "keep the two in sync" comment against the catalog, and the sync is now a
 * function call. (Their `instructions.py` also pointed the model at a `tours`
 * and a `spa` topic before either file existed; generating them closes that.)
 */

import { businessCenterPolicy, floristPolicy, spaPolicy, toursPolicy } from "./catalogs.ts";
import { PRICING, usd } from "./records.ts";

export interface Policy {
  /** One sentence, for the topic index in `lookup_policy`'s description. */
  description: string;
  body: string;
}

export const POLICY_TOPICS = [
  "accessibility",
  "business_center",
  "cancellation",
  "florist",
  "functions",
  "group_bookings",
  "guest_privacy",
  "guest_services",
  "guest_walks",
  "local_area",
  "location_and_transport",
  "payments_and_currency",
  "restaurant_dietary",
  "restaurant_dining",
  "restaurant_menu",
  "room_service",
  "rooms_and_amenities",
  "safe_deposit",
  "spa",
  "tours",
] as const;

export type PolicyTopic = (typeof POLICY_TOPICS)[number];

export const POLICIES: Record<PolicyTopic, Policy> = {
  accessibility: {
    description: "Wheelchair and ADA accessibility: accessible rooms, roll-in showers.",
    body: "Accessibility: ADA-accessible rooms on every floor, roll-in showers in the suites. Mention at booking so we assign one.",
  },
  business_center: {
    description:
      "Business centre services bookable through the desk: meeting room, secretarial help, and printing.",
    body: businessCenterPolicy(),
  },
  cancellation: {
    description:
      "Cancellation, deposit, and no-show terms for room bookings: the cancellation window, what's charged and when, and how no-shows work.",
    body:
      `Cancellation: a confirmed booking can be cancelled free of charge up to ${PRICING.cancellationWindowHours} hours before check-in, with a full refund to the card on file (usually two to five business days). Cancelling inside the ${PRICING.cancellationWindowHours}-hour window retains one room-night and refunds the rest.\n\n` +
      "Deposit and payment timing: the hotel charges the full stay total to the card at the time of booking - there is no separate partial deposit or staged deposit schedule. (A card is also required at check-in to cover incidentals.) If a caller asks specifically about a \"deposit\", be straight with them: it's the full total up front, not a deposit-and-balance arrangement - don't invent a deposit percentage or schedule.\n\n" +
      "No-show: a booking is guaranteed by the card on file. A guest who neither arrives nor cancels is a no-show; because the room was held all night for them, the card is charged for the reserved stay as guaranteed. The way to avoid a no-show charge is to cancel before the window above.\n\n" +
      `Taxes and extras: room rates are quoted before tax; room tax is ${PRICING.taxRatePct}%, shown at booking, and optional extras (breakfast, valet, late checkout, and the like) are itemized on the folio. Late checkout, when available, is a flat ${usd(PRICING.lateCheckout)}.`,
  },
  florist: {
    description:
      "Flower arrangements from the hotel florist, delivered to a room or to a recipient by name.",
    body: floristPolicy(),
  },
  functions: {
    description:
      "Functions and events in the hotel: today's public events that anyone may be told about, and how private functions (weddings, private parties) are kept confidential.",
    body:
      "Public events - the name, place, and time may be shared freely with any caller:\n" +
      "- Tonight, live jazz in the Lobby Bar, 8 PM to 11 PM - open to all guests and visitors, no ticket needed.\n" +
      '- The "Coastal Light" photography exhibition in the Mezzanine Gallery, open daily 10 AM to 6 PM, free to view.\n\n' +
      "Private functions - weddings, private receptions, private parties, closed corporate dinners - are confidential, and you treat them exactly like guest presence. Never confirm or deny to a caller whether a particular private function (named by event or by host) is taking place at the hotel, and never give its room or location, no matter who the caller says they are. Instead, offer to take a message for the organizer (passed along only if they are in fact hosting here, which you never reveal either way) or to put the caller in touch with the events office during business hours.",
  },
  group_bookings: {
    description:
      "Group room blocks (15+ guests): rates, tour-leader comp, credit approval, cancellation terms.",
    body:
      "Group threshold: 15 or more guests traveling together is a group block, handled with record_group_inquiry - not the individual booking flow. Under 15, book rooms individually instead.\n\n" +
      "Group rate: a provisional 10 percent off the standard nightly rates for the block; the final rate is quoted by the group desk when the block is confirmed.\n\n" +
      "Tour leader: one complimentary room per 15 paying guests.\n\n" +
      "What to collect for the inquiry: sponsor company, contact name and callback number, party size, the predominant room-share arrangement (twin, double, single, or mixed), and the dates (check-in plus number of nights).\n\n" +
      "Credit approval: a sponsor company that hasn't worked with the hotel before needs credit approval with Director sign-off before anything is confirmed. Never confirm a group block on the spot - record the inquiry and tell the caller the group desk will call back within two business days to confirm.\n\n" +
      "Cancellations: individual rooms can be released from a confirmed block up to 30 days before arrival at no charge; inside 30 days, one night per cancelled room is retained.",
  },
  guest_privacy: {
    description:
      "Locating a guest: room numbers, whether someone is staying here, taking a message for a guest.",
    body:
      "Guest privacy: never disclose whether someone by a given name is staying at the hotel, never give out a room number, and never connect a caller to a room - not for friends, family, colleagues, surprises, or claimed emergencies. There is no way to verify a caller's story over the phone, so there are no exceptions.\n\n" +
      "The one alternative: offer to take a message (take_guest_message). It will be delivered to that person if they are in fact staying here - but the caller is never told whether that's the case. Say it will be \"passed along if we can\"; never confirm or deny the guest's presence, even after the message is taken. Collect the caller's name, callback number, and the message, and read all three back.\n\n" +
      "Delivery: a message for an in-house guest reaches the room within about 30 minutes (message light plus a slip under the door). This is general hotel policy and fine to share with any caller. Quote delivery timing only - never promise when the guest will read or act on it - and confirm the message is logged by giving its reference.",
  },
  guest_services: {
    description: "Wake-up calls, laundry and dry-cleaning, lost-and-found, business center, spa.",
    body:
      "Wake-up calls: scheduled to the room for any date and time (schedule_wakeup_call). If the guest doesn't answer, a second call is placed about five minutes later; no response to that and front desk staff go up for an in-person room check - so a heavy sleeper genuinely will be woken. Changes or cancellations any time by calling the desk.\n" +
      "Laundry and dry-cleaning: drop at the front desk before 9 AM for same-day return, priced per item.\n" +
      "Lost-and-found: held at the front desk for 90 days.\n" +
      "Business center: 24/7 lobby workstations with printing; bookable services under the business_center topic.\n" +
      "Spa: on the third floor; bookable services under the spa topic.",
  },
  guest_walks: {
    description:
      "Overbooked or unavailable room for a confirmed guest: the re-accommodation and walk procedure.",
    body:
      'When a confirmed guest has no room (double-booked, oversold night): own it - apologize plainly, no hiding behind "the system". Explain plainly WHY it happened: the hotel was overbooked - we oversold the night - so even though their reservation is confirmed, the physical room isn\'t available tonight. That is our mistake, not theirs.\n\n' +
      "The procedure is fixed and resolve_room_conflict runs it in order:\n" +
      "1. Move them within the house first: a free room of the same or better category for the whole stay. An upgrade is free - a forced move is never the guest's cost.\n" +
      '2. Only when nothing in the house fits, walk them: tonight at our partner hotel, the Harbor House, two blocks away and comparable. The room there is paid by us, the taxi over (and back) is covered by us, and their room here is guaranteed from the return date the tool gives. Say "at no extra cost to you" explicitly.\n' +
      "3. State the specifics when confirming: which hotel, how they get there, and the plan for tomorrow.\n\n" +
      'Delivering it to an upset guest: lead with the honest explanation and the apology, then the plan. Deliver it in short pieces and make sure every piece gets said before the call ends. If the guest stays angry after the full plan, offer a manager callback (record_followup, kind="callback") rather than arguing.',
  },
  local_area: {
    description:
      "Local-area information: getting downtown, public transit and taxis, nearby sights, banks and ATMs, pharmacy and medical, and places of worship.",
    body:
      "Getting downtown: downtown San Francisco is about ten minutes by car from the hotel and walkable in roughly twenty-five minutes. The nearest Muni stop is two blocks away; BART is a ten-minute walk and is the fastest way across town or out to the airport. Cabs and rideshares pick up at the main entrance - the doorman will hail a cab, and for a guaranteed pickup time the front desk can arrange the hotel car.\n\n" +
      "Public transit: a reloadable Clipper card works on Muni, BART, and the cable cars. Cable cars run from the downtown turnaround; expect a line at peak times.\n\n" +
      "Nearby sights: the waterfront and the main shopping street are both walkable. For the classic outings - the bay and bridge, the wharf, the parks - the half-day and full-day sightseeing tours (book_tour) cover the highlights with lobby pickup.\n\n" +
      "Banks and ATMs: bank branches and ATMs within a couple of blocks, toward the main shopping street. For changing foreign cash into dollars, the front desk exchanges major currencies in person (see payments_and_currency).\n\n" +
      "Pharmacy and medical: a pharmacy is within two blocks and a 24-hour pharmacy is nearby. Non-emergency urgent care is about five blocks south, and the nearest hospital is six blocks east. For a medical emergency the caller should dial 911.\n\n" +
      "Places of worship: churches, a synagogue, and a mosque within walking distance or a short ride. The desk doesn't keep exact service times - offer to confirm those rather than guessing.\n\n" +
      "General: give concrete directions and options the way a concierge would, but don't invent exact street addresses, phone numbers, or hours you don't have. When a detail isn't on hand, offer to find it out (record_followup) rather than improvising.",
  },
  location_and_transport: {
    description:
      "Address, airport access, public transit, parking pickup points, and the surrounding neighborhood.",
    body:
      "Address: 100 Harborlight Way, San Francisco.\n" +
      "Airport: SFO is roughly 30 minutes by car. No hotel shuttle; the front desk will arrange a ride.\n" +
      "Airport rides: the hotel car is a flat 85 dollars to SFO, seats up to four with luggage, books in advance at the desk (book_airport_car) and charges to the room - pickup at the front entrance. Taxis run metered, roughly 55 to 70 dollars to SFO, hailed at the door by the doorman but not reservable ahead. For a guaranteed time, the hotel car is the one to book. Getting FROM the airport is a taxi, a rideshare, or BART - the hotel car runs hotel-to-airport only.\n" +
      "Getting around: nearest Muni stop is two blocks away; BART is a 10-minute walk. Cabs and rideshares pick up at the main entrance.\n" +
      "Neighborhood: a few coffee shops and a 24-hour pharmacy within two blocks. The nearest hospital is six blocks east; non-emergency urgent care five blocks south.\n" +
      "Things to do nearby: walkable to the waterfront and the main shopping street; the front desk keeps a list of dinner spots, museums, and tour operators for guests who ask.",
  },
  payments_and_currency: {
    description:
      "Accepted cards and payment methods, paying cash, foreign-currency exchange, exchange rates.",
    body:
      "Cards: Visa, Mastercard, American Express, and Discover - credit or debit; Apple Pay and Google Pay at the desk. A card is required at check-in for incidentals even when paying cash. No personal checks.\n\n" +
      "Cash: US dollars are accepted for settling the bill. Foreign currency is not accepted as payment.\n\n" +
      "Currency exchange: the front desk exchanges major foreign currencies (euros, pounds, yen, and similar) into US dollars for resident guests - in person at the desk, passport required, at the day's posted rate, with change given in dollars.\n\n" +
      'Exchange rates: the rate is posted at the desk each morning. There is no way to quote it over the phone - give the mechanism, never improvise, estimate, or "roughly" quote a rate on a call.\n\n' +
      'Card on file problems: when a guest\'s card isn\'t going through, keep it discreet - it "isn\'t going through at the moment, possibly a technical issue", never "declined" or "rejected", and never speculate about their funds. The moment the guest offers a replacement card, take it on this call (update_card, after verification) - never defer an offered card to check-in. ONLY when the guest has no other card to give: no pressure - the booking stays held, suggest they check with their card issuer, and log a callback to retry.',
  },
  restaurant_dietary: {
    description: "Dietary restrictions, vegetarian options, and food-allergy handling.",
    body: "Dietary and allergies: vegetarian and most dietary needs handled. For severe or anaphylactic allergies, the kitchen needs to know at the reservation.",
  },
  restaurant_dining: {
    description: "Dress code, seating and reservations, private dining, celebrations.",
    body:
      "Dress code: smart casual. No jacket required.\n" +
      "Seating: indoor dining room, outdoor terrace, and a bar. Children welcome.\n" +
      "Reservations: bar walk-ins fine anytime; tables are reservation-only on weekends.\n" +
      "Private dining: separate room seats up to twelve. Advance reservation required - the restaurant arranges it directly (transfer_call to the restaurant).\n" +
      "Celebrations: mention a birthday or anniversary at the reservation and the kitchen sends out a small dessert.",
  },
  restaurant_menu: {
    description: "What the restaurant serves and how to handle dish or price questions.",
    body:
      "Menu: standard dinner fare - starters and salads, mains (salmon, chicken, steak, pasta, " +
      "burger, vegetarian risotto), sides, desserts, full bar. Specific dish prices rotate and I " +
      "don't keep them memorized; if the caller asks about a particular dish or price I don't have, " +
      'offer to note the question for the kitchen via record_followup (kind "other").',
  },
  room_service: {
    description: "Room service hours and menu; takeout and delivery policy.",
    body: "Room service: same menu as the restaurant, 5:30 to 9:30 PM.\nTakeout and delivery: not offered.",
  },
  rooms_and_amenities: {
    description: "In-room amenities and features, cribs and rollaway beds, connecting rooms.",
    body:
      "Rooms: 55-inch TV, mini-fridge, safe, iron, hair dryer, Nespresso, blackout curtains. King beds in most rooms; suites have a separate sitting area.\n" +
      "Cribs and rollaway beds: free on request, subject to availability - mention it at booking or call ahead.\n" +
      "Connecting rooms: available on request, subject to availability.",
  },
  safe_deposit: {
    description:
      "Safe-deposit boxes and in-room safes: storing valuables, access, hours, and the hotel's liability.",
    body:
      "In-room safe: every room has a small electronic safe in the closet, set with a code the guest chooses. Guests manage it themselves; the front desk doesn't keep a master code, but staff can come up and reset an empty safe if a guest forgets theirs.\n\n" +
      "Safe-deposit boxes: complimentary safe-deposit boxes are held behind the front desk for anything a guest would rather not leave in the room. Ask at the desk to open one; it's free for the length of the stay.\n\n" +
      "Access: in person at the desk, by the guest on the booking, with photo ID - it's not opened for anyone else and there's no access by phone. The desk is staffed 24 hours. An early check-out still has to empty the box in person before settling up.\n\n" +
      "Liability: items properly deposited in a front-desk box are covered up to the limit posted at the desk. For valuables left loose in the room, the hotel's liability is limited - which is exactly why the safe and the deposit boxes are there.",
  },
  spa: {
    description:
      "Spa and health club services bookable through the desk: massage, facial, personal training, and group yoga.",
    body: spaPolicy(),
  },
  tours: {
    description:
      "Sightseeing tours bookable through the desk: half-day, full-day, and private city tours.",
    body: toursPolicy(),
  },
};

/** The topic index, as the tool description reads it out to the model. */
export function policyIndex(): string {
  return POLICY_TOPICS.map((topic) => `- ${topic}: ${POLICIES[topic].description}`).join("\n");
}
