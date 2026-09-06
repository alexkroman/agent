/**
 * Who the assistant works for, what is in their inbox, and what is on their
 * calendar — the three things EAIA reads from the outside world, frozen.
 *
 * Their `config.yaml` is {@link EXECUTIVE} and {@link DEFAULT_MEMORY}; their
 * `cron_graph` (Gmail polled every few minutes) is {@link INBOX}; their
 * `get_events_for_days` (Google Calendar) reads {@link CALENDAR}. A template
 * ships no credentials, so the world is a handful of rows — enough for every
 * triage category in their config to have one email that lands in it, and small
 * enough that a whole thread fits in a tool result with its brief beside it.
 *
 * Every date is relative to {@link TODAY}, which is fixed rather than read from
 * the clock: the meeting assistant reasons about "next week", and a fixture
 * that drifted past its own calendar would make that reasoning wrong on a date
 * nobody chose.
 */

// ─── The executive ───────────────────────────────────────────────────────────

/** Their `config.yaml`, minus the four preference prompts memory owns. */
export const EXECUTIVE = {
  email: "maya@lumenlabs.dev",
  fullName: "Maya Okafor",
  name: "Maya",
  background:
    "Maya is CEO and co-founder of Lumen Labs, a startup building developer tools for " +
    "voice agents.",
  timezone: "PST",
  triageNo: [
    "Automated emails from services that are spamming Maya",
    "Cold outreach from vendors — people trying to sell Maya things; she is not interested",
    "Threads where the question is best answered by someone else on the thread, unless " +
      "Maya was the one who sent the last email",
    "Receipts and notifications from Stripe, Vercel, Ramp and similar services",
    "Notifications of comments on Google Docs",
    "Automated calendar invitations",
  ],
  triageNotify: [
    "Google Docs that were newly shared with her (not comments)",
    "Docusign envelopes that still need her signature — the subject starts with 'Complete " +
      "with Docusign'. One starting 'Completed:' is already signed and needs nothing",
    "Anything technically detailed about Lumen Labs' product that she would want to see",
    "Emails with a clear action item for Maya from an earlier conversation",
  ],
  triageEmail: [
    "Emails from customers or prospects that explicitly ask Maya a question",
    "Emails from customers where Maya is the main driver of the conversation",
    "Emails from Lumen Labs team members that explicitly ask Maya a question",
    "Emails where Maya is introducing two people to each other",
    "Emails from customers or partners trying to set up a time to meet",
    "Any direct email from Maya's lawyers or about the board",
    "Emails where Lumen Labs is winning an award or being invited to a legitimate event",
    "Emails where the sender clearly has a pre-existing relationship with Maya",
    "Emails from friends — even ones that ask no explicit question",
  ],
} as const;

/** The four prompts memory can rewrite — their store keys, seeded from `config.yaml`. */
export interface Memory {
  /** Their `rewrite_instructions`: tone. */
  rewriteInstructions: string;
  /** Their `response_preferences`: what to put in an email. */
  responsePreferences: string;
  /** Their `schedule_preferences`: how to book a meeting. */
  schedulePreferences: string;
  /** Their `random_preferences`, seeded from `background_preferences`: who is who. */
  backgroundPreferences: string;
}

export const DEFAULT_MEMORY: Memory = {
  rewriteInstructions: [
    "Maya has a few rules for how she likes her emails written:",
    "- Match the sender's tone. Formal to formal, casual to casual.",
    "- With someone she clearly knows well, she is direct and to the point.",
    "- She does not want anyone to know she uses an assistant; sound like Maya, never like",
    "  an assistant writing for her.",
    "- When casual she skips greetings and sign-offs and just says the thing.",
  ].join("\n"),
  responsePreferences: "",
  schedulePreferences:
    "By default, unless specified otherwise, make meetings 30 minutes long, on weekdays " +
    "between 10am and 4pm Pacific.",
  backgroundPreferences:
    "Lumen Labs has a product marketer, Priya (priya@lumenlabs.dev). For emails where she " +
    "may be relevant — amplifying a podcast, a blog post or an event featuring Maya or Lumen " +
    "Labs — loop her in: add her to the thread and let her handle the ask rather than Maya.",
};

// ─── The inbox ───────────────────────────────────────────────────────────────

/** Their `EmailData`, minus Gmail's ids. */
export interface SeedEmail {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  sentAt: string;
}

/** The fixed "now" every date below is relative to — a Monday. */
export const TODAY = "2026-03-09";

/**
 * Eight emails, one per row of their config: three that want a reply, one that
 * wants a meeting, two the executive should hear about, two to file unread.
 * Ordered as the mail arrived, newest last.
 */
export const INBOX: readonly SeedEmail[] = [
  {
    id: "m1",
    threadId: "t1",
    from: "growth@leadblast.co",
    to: EXECUTIVE.email,
    subject: "10x your outbound pipeline this quarter",
    body:
      "Hi Maya, I came across Lumen Labs and loved what you are building. We help " +
      "founders like you book 40+ qualified demos a month with our AI SDR platform. Do " +
      "you have 15 minutes this week for a quick walkthrough?",
    sentAt: `${TODAY}T07:02:00`,
  },
  {
    id: "m2",
    threadId: "t2",
    from: "dana.whitfield@northwind.io",
    to: EXECUTIVE.email,
    subject: "Quick question on the on-prem option",
    body:
      "Maya — great call last week. Our security team is asking whether the on-prem " +
      "deployment runs the speech models inside our VPC or still calls out to your " +
      "cloud for inference. If it stays inside, we can move to a pilot this month. Dana",
    sentAt: `${TODAY}T07:48:00`,
  },
  {
    id: "m3",
    threadId: "t3",
    from: "dse@docusign.net",
    to: EXECUTIVE.email,
    subject: "Complete with Docusign: Lumen Labs — Office Lease Amendment",
    body:
      "Goodwin Procter LLP sent you a document to review and sign. Lumen Labs — Office " +
      "Lease Amendment (2 pages). Please review and sign at your earliest convenience.",
    sentAt: `${TODAY}T08:15:00`,
  },
  {
    id: "m4",
    threadId: "t4",
    from: "sam.reyes@acme-partners.com",
    to: EXECUTIVE.email,
    subject: "Time to catch up next week?",
    body:
      "Hi Maya, it has been a while since the partnership kickoff. I would love thirty " +
      "minutes next week to walk you through the integration roadmap and hear what your " +
      "customers are asking for. Tuesday or Wednesday afternoon works best on my side — " +
      "does either work for you? Best, Sam",
    sentAt: `${TODAY}T08:40:00`,
  },
  {
    id: "m5",
    threadId: "t5",
    from: "receipts@stripe.com",
    to: EXECUTIVE.email,
    subject: "Your receipt from Vercel Inc. #2119-4471",
    body:
      "Receipt from Vercel Inc. Amount paid $240.00. Date paid March 9, 2026. Payment " +
      "method Visa ending 4471. Pro plan, 12 seats.",
    sentAt: `${TODAY}T09:03:00`,
  },
  {
    id: "m6",
    threadId: "t6",
    from: "host@buildersweekly.fm",
    to: EXECUTIVE.email,
    subject: "Your episode is live — would you share it?",
    body:
      "Maya, thanks again for coming on Builders Weekly. Your episode went live this " +
      "morning and is already our most-played of the month. Would you be up for sharing " +
      "it on LinkedIn and X this week? Happy to send over some quote cards. — Theo",
    sentAt: `${TODAY}T09:30:00`,
  },
  {
    id: "m7",
    threadId: "t7",
    from: "jonas@lumenlabs.dev",
    to: EXECUTIVE.email,
    subject: "Can I quote the Q3 number in the board deck?",
    body:
      "Hey Maya — putting the board deck together. Are we okay quoting the Q3 net revenue " +
      "retention figure (128%) on the metrics slide, or do you want to keep that internal " +
      "until the audit closes? Need to know by Thursday. Jonas",
    sentAt: `${TODAY}T10:12:00`,
  },
  {
    id: "m8",
    threadId: "t8",
    from: "lena.park@gmail.com",
    to: EXECUTIVE.email,
    subject: "that ramen place",
    body:
      "finally tried the place you kept telling me about. you were right, the tonkotsu is " +
      "unreal. we should go when you're back in the city — maybe the weekend after next?",
    sentAt: `${TODAY}T11:05:00`,
  },
];

// ─── The calendar ────────────────────────────────────────────────────────────

export interface CalendarEvent {
  /** ISO date, `YYYY-MM-DD`. */
  date: string;
  /** Local time, `HH:MM`, 24-hour. */
  start: string;
  end: string;
  title: string;
}

/** This week and next, as their `get_events_for_days` would return them. */
export const CALENDAR: readonly CalendarEvent[] = [
  { date: "2026-03-09", start: "09:00", end: "09:30", title: "Leadership sync" },
  { date: "2026-03-09", start: "13:00", end: "15:00", title: "Hiring loop — staff engineer" },
  { date: "2026-03-10", start: "10:00", end: "11:00", title: "Board prep with Jonas" },
  { date: "2026-03-10", start: "14:00", end: "15:00", title: "Northwind pilot review" },
  { date: "2026-03-11", start: "11:00", end: "12:00", title: "Investor update drafting" },
  { date: "2026-03-12", start: "09:00", end: "12:00", title: "Offsite — product roadmap" },
  { date: "2026-03-13", start: "15:00", end: "16:00", title: "1:1 — Priya" },
  { date: "2026-03-16", start: "09:00", end: "09:30", title: "Leadership sync" },
  { date: "2026-03-17", start: "13:00", end: "14:00", title: "Customer call — Fable Health" },
  { date: "2026-03-17", start: "15:00", end: "17:00", title: "Board meeting" },
  { date: "2026-03-18", start: "10:00", end: "11:30", title: "Design review" },
  { date: "2026-03-19", start: "14:00", end: "15:00", title: "Podcast recording" },
  { date: "2026-03-20", start: "11:00", end: "12:00", title: "All hands" },
];
