import "@alexkroman1/aai-ui/styles.css";
import { mountClient, useAgentState } from "@alexkroman1/aai-ui";
import type { ReactNode } from "react";
import { type DeskView, deskProjection } from "./shared.ts";

/**
 * The receptionist's screen — their `ui_view.py`, which streamed SQLite
 * changesets to the playground so a watcher could see the database change as
 * the call went on. `syncState` is that stream: the projection is pushed after
 * every tool call, and this renders the three things a desk agent glances at
 * between sentences — who they are talking to, how far the booking has got, and
 * what this call has written.
 */

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[11px] font-bold uppercase tracking-wider opacity-60">{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex justify-between gap-3 text-sm">
      <span className="opacity-60">{label}</span>
      <span className={value === null ? "opacity-40 italic" : "text-right font-medium"}>
        {value ?? "pending"}
      </span>
    </div>
  );
}

const KIND_LABELS: Record<DeskView["ledger"][number]["kind"], string> = {
  followup: "Followup",
  wakeup_call: "Wake-up call",
  do_not_disturb: "Do not disturb",
  waitlist: "Waitlist",
  tour: "Tour",
  spa: "Spa",
  business_center: "Business centre",
  flowers: "Florist",
  email: "Email",
  transfer: "Transfer",
  flight_reconfirmation: "Flight",
  airport_car: "Hotel car",
  emergency: "EMERGENCY",
  guest_message: "Guest message",
  group_inquiry: "Group inquiry",
  walk: "Walk",
};

function DeskSidebar() {
  const desk = useAgentState(deskProjection);
  return (
    <div className="flex flex-col gap-6 p-4 text-aai-text">
      <Section title="Tonight">
        <Row label="In house" value={String(desk.inHouse)} />
        <Row label="Arriving today" value={String(desk.arrivingToday)} />
      </Section>

      <Section title="Verified guest">
        {desk.verified ? (
          <div className="rounded-lg bg-aai-surface p-3 flex flex-col gap-1">
            <Row label="Guest" value={desk.verified.name} />
            <Row label="Booking" value={desk.verified.code} />
            <Row label="Room" value={desk.verified.room} />
            <Row label="Stay" value={desk.verified.stay} />
            <Row label="Status" value={desk.verified.status} />
          </div>
        ) : (
          <p className="text-sm opacity-50">No one verified on this call.</p>
        )}
      </Section>

      <Section
        title={desk.draft?.mode === "modify" ? "Modifying a booking" : "Booking in progress"}
      >
        {desk.draft ? (
          <div className="rounded-lg bg-aai-surface p-3 flex flex-col gap-1">
            <Row label="Stay" value={desk.draft.stay} />
            <Row label="Room" value={desk.draft.room} />
            <Row label="Extras" value={desk.draft.extras} />
            <Row label="Guest" value={desk.draft.guest} />
            <Row label="Card" value={desk.draft.card} />
            <Row label="Total" value={desk.draft.total} />
          </div>
        ) : (
          <p className="text-sm opacity-50">No booking flow open.</p>
        )}
      </Section>

      <Section title="Written this call">
        {desk.ledger.length === 0 ? (
          <p className="text-sm opacity-50">Nothing yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {desk.ledger.map((t) => (
              <li
                key={t.code}
                className="rounded-lg bg-aai-surface p-2 text-xs flex flex-col gap-0.5"
              >
                <div className="flex justify-between gap-2">
                  <span
                    className={
                      t.kind === "emergency"
                        ? "font-bold text-red-400"
                        : "font-bold text-aai-primary"
                    }
                  >
                    {KIND_LABELS[t.kind]}
                  </span>
                  <span className="opacity-60 font-mono">{t.code}</span>
                </div>
                <span className="opacity-80">{t.summary}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

mountClient({
  name: "The Harborlight Hotel",
  sidebar: DeskSidebar,
  sidebarWidth: "22rem",
  theme: {
    bg: "#101418",
    primary: "#c8a96e",
    text: "#f2ede4",
    surface: "#1a2026",
    border: "#2a323b",
  },
});
