/**
 * Their `fake_data/seed.py`, as data: thirteen rooms, ten tables, the bookings
 * and reservations that make every scenario in their `scenarios_*.yaml`
 * reproducible, five settled disputes, and one returning guest.
 *
 * Every date is an OFFSET from `today`, exactly as theirs are, and the offsets
 * are load-bearing rather than decorative — each cluster below exists so that
 * some tool has a real case to hit:
 *
 * - **Tonight is oversold.** Dana Holt holds room 301 through tomorrow — and so
 *   does Kenji Tanaka, who checked in today. The four one-nighters fill every
 *   otherwise-free room TONIGHT ONLY, so the re-accommodation search honestly
 *   comes up empty and Tanaka is WALKED, while 301 frees tomorrow.
 * - **205, the garden queen, stays free tonight on purpose.** It is the one
 *   concrete fix the desk can offer Robert Klein ("I booked a garden view!"), and
 *   it is cheaper than Tanaka's king, so the walk resolver — which only looks at
 *   the same category or better — correctly never offers it to him.
 * - **Next weekend is double-booked too, and the house can absorb it.** Tom
 *   Whelan's ocean queen collides with Grace Lin's stay, the other ocean queen
 *   is blocked by Noah Petrov, and the resolver considers only rooms at or above
 *   the rate already paid — so the city and garden queens stay out of reach and
 *   the cheapest room left is a SUITE: the free-upgrade scenario.
 * - **Friday, July 3 is sold out** (offset 25, the July-4th weekend): all
 *   thirteen rooms, one night each, so a booking inquiry for that night comes up
 *   empty and the waitlist has a reason to exist.
 * - **The departed stays are the source of invoices and disputes**, the no-show
 *   is the angry charge dispute, and Felix Wagner's cancelled stay is "I
 *   cancelled, where is my refund" — and the one booking `reinstate_booking`
 *   can bring back.
 *
 * The Smith / García / Lee codes were referenced by their playground and are
 * kept stable; `agent.eval.test.ts` names them too.
 */

import {
  addDays,
  computeInvoice,
  type Dispute,
  type DisputeCategory,
  type GuestHistory,
  type Invoice,
  PRICING,
  type Reservation,
  type RestaurantTable,
  type Room,
  type RoomBooking,
  type RoomExtra,
  type RoomType,
  type RoomView,
} from "./records.ts";

/** What {@link seedHotel} builds — the record half of the session state. */
export interface HotelSeed {
  rooms: Room[];
  tables: RestaurantTable[];
  bookings: RoomBooking[];
  reservations: Reservation[];
  invoices: Invoice[];
  disputes: Dispute[];
  guestHistory: GuestHistory[];
}

type RoomRow = [
  id: string,
  type: RoomType,
  rate: number,
  occupancy: number,
  smoking: 0 | 1,
  pets: 0 | 1,
  view: RoomView,
];

// (room number, type, nightly rate in cents, max occupancy, smoking, pets, view)
const ROOMS: readonly RoomRow[] = [
  ["201", "king", 24_000, 2, 0, 0, "city"],
  ["202", "king", 26_000, 2, 0, 1, "ocean"],
  ["203", "king", 24_000, 2, 1, 0, "city"],
  ["204", "queen_2beds", 22_000, 4, 0, 0, "city"],
  ["205", "queen_2beds", 22_000, 4, 0, 1, "garden"],
  ["206", "queen_2beds", 26_000, 4, 0, 0, "ocean"],
  ["301", "king", 28_000, 2, 0, 0, "ocean"],
  ["302", "king", 28_000, 2, 0, 0, "ocean"],
  ["303", "queen_2beds", 24_000, 4, 0, 0, "city"],
  ["304", "queen_2beds", 28_000, 4, 0, 1, "ocean"],
  ["401", "suite", 48_000, 4, 0, 1, "ocean"],
  ["402", "suite", 52_000, 4, 0, 0, "ocean"],
  ["PH", "penthouse", 120_000, 6, 0, 1, "ocean"],
];

type TableRow = [
  label: string,
  capacity: number,
  location: RestaurantTable["location"],
  description: string,
];

const TABLES: readonly TableRow[] = [
  ["T-01", 2, "indoor", "Window two-top overlooking the harbor"],
  ["T-02", 2, "indoor", "Quiet corner booth, tucked beside the wine wall"],
  ["T-03", 4, "indoor", "Round table beneath the chandelier"],
  ["T-04", 4, "indoor", "Velvet banquette along the main dining wall"],
  ["T-05", 6, "indoor", "Chef's table facing the open kitchen"],
  ["P-01", 2, "terrace", "Intimate table for two at the terrace railing"],
  ["P-02", 4, "terrace", "Terrace table under the string lights"],
  ["P-03", 4, "terrace", "Shaded terrace table by the herb garden"],
  ["B-01", 2, "bar", "High-top at the end of the marble bar"],
  ["B-02", 2, "bar", "Counter seats facing the bartenders"],
];

type BookingRow = [
  first: string,
  last: string,
  email: string,
  phone: string,
  codeSuffix: string,
  room: string,
  offsetDays: number,
  nights: number,
  guests: number,
  extras: RoomExtra[],
  card4: string,
  status: RoomBooking["status"],
];

// offset < 0 and offset + nights > 0 → in-house now; offset > 0 → upcoming; else departed.
const BOOKINGS: readonly BookingRow[] = [
  // In-house right now
  [
    "Sofía",
    "García",
    "sofia.garcia@proton.me",
    "+1 415 555 0107",
    "EF56",
    "401",
    -1,
    4,
    3,
    ["breakfast", "valet", "pets"],
    "0007",
    "confirmed",
  ],
  [
    "Priya",
    "Nair",
    "priya.nair@gmail.com",
    "+1 510 555 0188",
    "KM21",
    "202",
    -2,
    4,
    2,
    ["breakfast"],
    "3310",
    "confirmed",
  ],
  [
    "Amara",
    "Okafor",
    "amara.okafor@gmail.com",
    "+1 650 555 0121",
    "WX53",
    "206",
    -1,
    2,
    4,
    ["breakfast", "pets"],
    "5550",
    "confirmed",
  ],
  [
    "Lucas",
    "Meyer",
    "lucas.meyer@gmx.de",
    "+49 30 5550173",
    "ZP19",
    "402",
    -3,
    5,
    2,
    ["breakfast", "valet"],
    "9041",
    "confirmed",
  ],
  [
    "Vivienne",
    "Laurent",
    "v.laurent@me.com",
    "+1 415 555 0193",
    "PH01",
    "PH",
    -2,
    6,
    2,
    ["breakfast", "valet", "pets"],
    "1206",
    "confirmed",
  ],
  // In-house and being fished for by an outside caller — presence must never be disclosed
  [
    "Jonathan",
    "Pierce",
    "j.pierce@gmail.com",
    "+1 415 555 0233",
    "JP65",
    "303",
    -1,
    3,
    1,
    [],
    "5151",
    "confirmed",
  ],
  // In-house with an early flight — the wake-up call caller
  [
    "Frank",
    "Adler",
    "frank.adler@gmail.com",
    "+1 415 555 0277",
    "FA09",
    "304",
    -1,
    3,
    1,
    [],
    "6203",
    "confirmed",
  ],
  // Full house tonight (oversold): Holt and Tanaka both hold 301 through tomorrow
  [
    "Dana",
    "Holt",
    "dana.holt@gmail.com",
    "+1 415 555 0341",
    "DH27",
    "301",
    -2,
    3,
    2,
    [],
    "9034",
    "confirmed",
  ],
  [
    "Paul",
    "Greer",
    "paul.greer@gmail.com",
    "+1 415 555 0356",
    "PG11",
    "203",
    0,
    1,
    1,
    [],
    "2218",
    "confirmed",
  ],
  [
    "Rita",
    "Moss",
    "rita.moss@me.com",
    "+1 415 555 0368",
    "QM17",
    "204",
    0,
    1,
    2,
    [],
    "7745",
    "confirmed",
  ],
  [
    "Lena",
    "Fischer",
    "lena.fischer@gmx.de",
    "+49 30 5550441",
    "LF73",
    "302",
    0,
    1,
    1,
    [],
    "6071",
    "confirmed",
  ],
  // Double-booked next weekend, but the house can absorb it: the free-upgrade scenario
  [
    "Tom",
    "Whelan",
    "tom.whelan@gmail.com",
    "+1 415 555 0457",
    "TW55",
    "206",
    4,
    3,
    4,
    [],
    "5126",
    "confirmed",
  ],
  [
    "Grace",
    "Lin",
    "grace.lin@gmail.com",
    "+1 415 555 0463",
    "GL09",
    "206",
    3,
    3,
    3,
    [],
    "8854",
    "confirmed",
  ],
  [
    "Noah",
    "Petrov",
    "noah.petrov@gmail.com",
    "+1 415 555 0478",
    "NP66",
    "304",
    3,
    4,
    4,
    [],
    "1937",
    "confirmed",
  ],
  [
    "Kenji",
    "Tanaka",
    "kenji.tanaka@gmail.com",
    "+1 415 555 0164",
    "RT88",
    "301",
    0,
    3,
    2,
    ["valet"],
    "7782",
    "confirmed",
  ],
  // Checked in today, king city room — insists he booked a garden view; the record says otherwise
  [
    "Robert",
    "Klein",
    "robert.klein@gmail.com",
    "+1 415 555 0377",
    "RK20",
    "201",
    0,
    2,
    1,
    [],
    "8412",
    "confirmed",
  ],
  // Arriving tomorrow
  [
    "Hiroshi",
    "Sato",
    "h.sato@gmail.com",
    "+1 415 555 0211",
    "BN23",
    "204",
    1,
    2,
    3,
    ["breakfast"],
    "8821",
    "confirmed",
  ],
  // Upcoming
  [
    "Eleanor",
    "Smith",
    "eleanor.smith@gmail.com",
    "+1 415 555 0142",
    "AB12",
    "203",
    5,
    2,
    2,
    ["breakfast"],
    "4242",
    "confirmed",
  ],
  [
    "Marcus",
    "Johnson",
    "m.johnson@outlook.com",
    "+1 628 555 0199",
    "CD34",
    "205",
    9,
    3,
    4,
    ["breakfast", "valet"],
    "1881",
    "confirmed",
  ],
  // Smoking room (203 is the only smoking-permitted room)
  [
    "Mei",
    "Chen",
    "mei.chen@gmail.com",
    "+1 415 555 0222",
    "MN42",
    "203",
    14,
    2,
    2,
    ["breakfast"],
    "4477",
    "confirmed",
  ],
  // Completely sold out one night (offset 25 = Fri Jul 3, the July-4th weekend)
  [
    "Owen",
    "Carver",
    "owen.carver@gmail.com",
    "+1 415 555 0501",
    "SO01",
    "201",
    25,
    1,
    2,
    [],
    "1101",
    "confirmed",
  ],
  [
    "Bianca",
    "Ross",
    "bianca.ross@gmail.com",
    "+1 415 555 0502",
    "SO02",
    "202",
    25,
    1,
    2,
    [],
    "1102",
    "confirmed",
  ],
  [
    "Caleb",
    "Nguyen",
    "caleb.nguyen@gmail.com",
    "+1 415 555 0503",
    "SO03",
    "203",
    25,
    1,
    2,
    [],
    "1103",
    "confirmed",
  ],
  [
    "Delia",
    "Brooks",
    "delia.brooks@gmail.com",
    "+1 415 555 0504",
    "SO04",
    "204",
    25,
    1,
    3,
    [],
    "1104",
    "confirmed",
  ],
  [
    "Ezra",
    "Flynn",
    "ezra.flynn@gmail.com",
    "+1 415 555 0505",
    "SO05",
    "205",
    25,
    1,
    3,
    [],
    "1105",
    "confirmed",
  ],
  [
    "Farah",
    "Haddad",
    "farah.haddad@gmail.com",
    "+1 415 555 0506",
    "SO06",
    "206",
    25,
    1,
    4,
    [],
    "1106",
    "confirmed",
  ],
  [
    "Gideon",
    "Park",
    "gideon.park@gmail.com",
    "+1 415 555 0507",
    "SO07",
    "301",
    25,
    1,
    2,
    [],
    "1107",
    "confirmed",
  ],
  [
    "Helena",
    "Cruz",
    "helena.cruz@gmail.com",
    "+1 415 555 0508",
    "SO08",
    "302",
    25,
    1,
    2,
    [],
    "1108",
    "confirmed",
  ],
  [
    "Ivan",
    "Sokolov",
    "ivan.sokolov@gmail.com",
    "+1 415 555 0509",
    "SO09",
    "303",
    25,
    1,
    3,
    [],
    "1109",
    "confirmed",
  ],
  [
    "Jana",
    "Novak",
    "jana.novak@gmail.com",
    "+1 415 555 0510",
    "SO10",
    "304",
    25,
    1,
    4,
    [],
    "1110",
    "confirmed",
  ],
  [
    "Kofi",
    "Mensah",
    "kofi.mensah@gmail.com",
    "+1 415 555 0511",
    "SO11",
    "401",
    25,
    1,
    4,
    [],
    "1111",
    "confirmed",
  ],
  [
    "Lara",
    "Conti",
    "lara.conti@gmail.com",
    "+1 415 555 0512",
    "SO12",
    "402",
    25,
    1,
    2,
    [],
    "1112",
    "confirmed",
  ],
  [
    "Mateo",
    "Rivas",
    "mateo.rivas@gmail.com",
    "+1 415 555 0513",
    "SO13",
    "PH",
    25,
    1,
    5,
    [],
    "1113",
    "confirmed",
  ],
  // Departed — the source of invoice lookups and disputes
  [
    "Daniel",
    "Lee",
    "daniel.lee@gmail.com",
    "+1 415 555 0104",
    "GH78",
    "302",
    -6,
    2,
    2,
    ["late_checkout"],
    "9999",
    "confirmed",
  ],
  [
    "Olivia",
    "Brandt",
    "olivia.brandt@me.com",
    "+1 415 555 0288",
    "QT55",
    "204",
    -10,
    3,
    2,
    ["breakfast"],
    "6677",
    "confirmed",
  ],
  [
    "Aino",
    "Virtanen",
    "aino.virtanen@gmail.com",
    "+358 9 5550144",
    "JX31",
    "303",
    -14,
    4,
    3,
    ["breakfast", "valet"],
    "5512",
    "confirmed",
  ],
  // No-show: card-guaranteed, charged, no cancellation on record — the angry dispute
  [
    "Tanya",
    "Richardson",
    "tanya.richardson@gmail.com",
    "+1 248 555 0291",
    "NS44",
    "304",
    -4,
    2,
    1,
    [],
    "7321",
    "confirmed",
  ],
  // Cancelled — "I cancelled, where's my refund", and the one `reinstate_booking` can revive
  [
    "Felix",
    "Wagner",
    "felix.wagner@me.com",
    "+1 415 555 0312",
    "FW77",
    "402",
    3,
    2,
    2,
    ["breakfast", "valet"],
    "2299",
    "cancelled",
  ],
];

type ReservationRow = [
  first: string,
  last: string,
  phone: string,
  party: number,
  offsetDays: number,
  time: string,
  codeSuffix: string,
  table: string,
  notes: string | null,
  status: Reservation["status"],
];

const RESERVATIONS: readonly ReservationRow[] = [
  // Tonight
  ["Marcus", "Bennett", "+1 415 555 0231", 4, 0, "19:00", "JK90", "T-03", "Birthday", "confirmed"],
  [
    "Hannah",
    "Kowalski",
    "+1 415 555 0244",
    2,
    0,
    "20:30",
    "LM12",
    "T-01",
    "Anniversary",
    "confirmed",
  ],
  [
    "Sofía",
    "García",
    "+1 415 555 0107",
    6,
    0,
    "19:30",
    "NP21",
    "T-05",
    "Family dinner",
    "confirmed",
  ],
  ["Diego", "Herrera", "+1 415 555 0259", 2, 0, "18:00", "QR34", "B-01", null, "confirmed"],
  // Tomorrow
  ["Yuki", "Sato", "+1 415 555 0277", 2, 1, "20:00", "ST56", "P-01", null, "confirmed"],
  ["Olivia", "Brandt", "+1 415 555 0288", 4, 1, "18:00", "UV78", "T-04", null, "confirmed"],
  // Day after tomorrow
  ["Tomás", "Silva", "+1 415 555 0290", 4, 2, "18:30", "WX90", "T-04", null, "confirmed"],
  [
    "Naomi",
    "Adeyemi",
    "+1 415 555 0301",
    4,
    2,
    "19:30",
    "YZ12",
    "T-04",
    "Window seat",
    "confirmed",
  ],
  // Later this week
  ["Felix", "Wagner", "+1 415 555 0312", 4, 4, "20:30", "AC34", "T-04", null, "confirmed"],
  ["Chiamaka", "Eze", "+1 415 555 0333", 2, 5, "19:00", "BD45", "P-02", null, "confirmed"],
  // Cancelled this morning
  ["Chen", "Wei", "+1 415 555 0344", 4, 1, "20:00", "CW10", "T-04", null, "cancelled"],
  // Last night
  [
    "Antonio",
    "Russo",
    "+1 415 555 0355",
    2,
    -1,
    "19:30",
    "AR22",
    "T-02",
    "Anniversary",
    "confirmed",
  ],
];

type DisputeRow = [
  caseNumber: string,
  bookingCode: string,
  lineItem: string,
  amount: number,
  category: DisputeCategory,
  note: string,
  outcome: Dispute["outcome"],
  refund: number,
  status: Dispute["status"],
];

// One resolved dispute per policy outcome, plus one still open.
const DISPUTES: readonly DisputeRow[] = [
  [
    "DSP-4K7M",
    "HTL-GH78",
    "Late checkout",
    PRICING.lateCheckout,
    "late_checkout_fee",
    "Front desk said a 1 PM checkout would be fine.",
    "goodwill_waived",
    PRICING.lateCheckout,
    "resolved",
  ],
  [
    "DSP-9X2C",
    "HTL-EF56",
    "Minibar",
    1800,
    "minibar",
    "Says they never opened the minibar.",
    "auto_refunded",
    1800,
    "resolved",
  ],
  [
    "DSP-5R8K",
    "HTL-QT55",
    "Room (3 nights)",
    66_000,
    "double_charge_billing_error",
    "Charged twice for the same stay - duplicate on the statement.",
    "auto_refunded",
    66_000,
    "resolved",
  ],
  [
    "DSP-7M3X",
    "HTL-JX31",
    "Pet fee",
    5000,
    "damage_cleaning",
    "No pet on the stay, but pet cleaning fee on the invoice.",
    "explained_no_action",
    0,
    "resolved",
  ],
  [
    "DSP-2H6T",
    "HTL-ZP19",
    "Room service",
    8800,
    "room_service_restaurant",
    "Charged for a dinner they didn't order.",
    "escalated_to_manager",
    0,
    "open",
  ],
];

const GUEST_HISTORY: readonly GuestHistory[] = [
  {
    lastName: "Lee",
    preferences:
      "Prefers a high, quiet floor away from the elevator, " +
      "and feather-free (hypoallergenic) pillows. " +
      "Had a noise complaint on a previous stay.",
  },
];

/** Their `populate()`: the seed rows materialized around `today`. */
export function seedHotel(today: string): HotelSeed {
  const rooms: Room[] = ROOMS.map(([id, type, nightlyRate, maxOccupancy, smoking, pets, view]) => ({
    id,
    type,
    nightlyRate,
    maxOccupancy,
    smoking: smoking === 1,
    petsAllowed: pets === 1,
    view,
  }));
  const tables: RestaurantTable[] = TABLES.map(([label, capacity, location, description], i) => ({
    id: i + 1,
    label,
    capacity,
    location,
    description,
  }));

  const bookings: RoomBooking[] = [];
  const invoices: Invoice[] = [];
  for (const [
    first,
    last,
    email,
    phone,
    suffix,
    roomId,
    offset,
    nights,
    guests,
    extras,
    card4,
    status,
  ] of BOOKINGS) {
    const room = rooms.find((r) => r.id === roomId);
    if (room === undefined) throw new Error(`seed references unknown room ${roomId}`);
    const checkIn = addDays(today, offset);
    const priced = computeInvoice(room.nightlyRate, nights, extras);
    const code = `HTL-${suffix}`;
    bookings.push({
      code,
      roomId,
      firstName: first,
      lastName: last,
      email,
      phone,
      checkIn,
      checkOut: addDays(checkIn, nights),
      guests,
      extras: [...extras].sort(),
      total: priced.total,
      cardLast4: card4,
      status,
      lateArrivalNote: null,
    });
    invoices.push({
      bookingCode: code,
      lineItems: priced.lineItems,
      subtotal: priced.subtotal,
      taxes: priced.taxes,
      total: priced.total,
      paid: offset <= 0 && status === "confirmed",
    });
  }

  const reservations: Reservation[] = RESERVATIONS.map(
    ([first, last, phone, partySize, offset, time, suffix, label, notes, status]) => {
      const table = tables.find((t) => t.label === label);
      if (table === undefined) throw new Error(`seed references unknown table ${label}`);
      return {
        code: `RES-${suffix}`,
        tableId: table.id,
        firstName: first,
        lastName: last,
        phone,
        partySize,
        date: addDays(today, offset),
        time,
        notes,
        status,
      };
    },
  );

  const disputes: Dispute[] = [];
  for (const [
    caseNumber,
    bookingCode,
    lineItem,
    amount,
    category,
    callerNote,
    outcome,
    refundAmount,
    status,
  ] of DISPUTES) {
    disputes.push({
      caseNumber,
      bookingCode,
      lineItem,
      amount,
      category,
      callerNote,
      outcome,
      refundAmount,
      status,
    });
    // Mirrors `fileDispute`: a refund decrements the invoice total.
    const invoice = invoices.find((i) => i.bookingCode === bookingCode);
    if (invoice && refundAmount > 0) invoice.total -= refundAmount;
  }

  return {
    rooms,
    tables,
    bookings,
    reservations,
    invoices,
    disputes,
    guestHistory: GUEST_HISTORY.map((g) => ({ ...g })),
  };
}
