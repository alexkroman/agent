import "@alexkroman1/aai-ui/styles.css";
import { AutoScroll, mountClient, useAgentState } from "@alexkroman1/aai-ui";
import type { TripView } from "./shared.ts";
import { SPECIALIST_IDS, SPECIALISTS, tripProjection } from "./shared.ts";

const DESKS = ["primary", ...SPECIALIST_IDS] as const;

function deskLabel(id: (typeof DESKS)[number]): string {
  return id === "primary" ? "concierge" : SPECIALISTS[id].title;
}

/**
 * The dialog stack, rendered. This is the panel that earns its place: the
 * caller cannot see which desk is holding the call, and neither can a reader of
 * the transcript — the whole delegation mechanism is otherwise invisible.
 */
function DeskStrip({ active }: { active: TripView["assistant"] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {DESKS.map((id) => {
        const on = id === active;
        return (
          <span
            key={id}
            className={`rounded-full px-2.5 py-1 text-[11px] font-medium capitalize ${
              on ? "bg-aai-primary text-aai-bg" : "bg-aai-surface text-aai-text opacity-55"
            }`}
          >
            {deskLabel(id)}
          </span>
        );
      })}
    </div>
  );
}

function ItinerarySidebar() {
  const trip = useAgentState(tripProjection);

  return (
    <div className="flex flex-col gap-4 p-4 h-full min-h-0 text-aai-text">
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-bold opacity-60 uppercase tracking-wide">{trip.passenger}</h3>
        <DeskStrip active={trip.assistant} />
      </div>

      {/* The staged action — the browser half of the confirmation gate. What is
          on screen is exactly what the concierge just asked out loud. */}
      {trip.pending && (
        <div className="rounded-lg p-3 text-sm bg-aai-surface border border-aai-primary">
          <p className="text-[11px] font-bold uppercase tracking-wide opacity-60">
            Waiting on your yes
          </p>
          <p className="mt-1 capitalize">{trip.pending}</p>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <p className="text-[11px] font-bold uppercase tracking-wide opacity-60">Ticket</p>
        {trip.ticket ? (
          <div className="rounded-lg p-3 bg-aai-surface">
            <p className="text-sm font-medium">
              {trip.ticket.flightId} · {trip.ticket.route}
            </p>
            <p className="text-xs opacity-60">
              {trip.ticket.departs} · ref {trip.ticket.reference}
            </p>
          </div>
        ) : (
          <p className="text-sm opacity-50">No ticket — cancelled on this call.</p>
        )}
      </div>

      {trip.bookings.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-[11px] font-bold uppercase tracking-wide opacity-60">Booked</p>
          {trip.bookings.map((booking) => (
            <div
              key={booking.reference}
              className="flex items-center justify-between gap-3 rounded-lg p-3 bg-aai-surface"
            >
              <div className="min-w-0">
                <p className="truncate text-sm">{booking.summary}</p>
                <p className="text-xs opacity-60">{booking.reference}</p>
              </div>
              <span className="text-sm font-bold text-aai-primary">
                ${booking.price.toLocaleString("en-US")}
              </span>
            </div>
          ))}
          <div className="flex justify-between border-t border-aai-border pt-2 text-sm font-bold">
            <span>Total</span>
            <span className="text-aai-primary">${trip.total.toLocaleString("en-US")}</span>
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <p className="text-[11px] font-bold uppercase tracking-wide opacity-60">Call log</p>
        <AutoScroll
          scrollClassName="overflow-y-auto min-h-0"
          contentClassName="flex flex-col gap-1 pr-1"
        >
          {trip.log.length === 0 ? (
            <p className="text-xs opacity-40">Nothing yet.</p>
          ) : (
            trip.log.map((entry, index) => (
              // The log is append-only and capped, so the index is stable for
              // an entry's lifetime — there is no reorder to lose.
              <p key={`${index}-${entry}`} className="text-xs opacity-70">
                {entry}
              </p>
            ))
          )}
        </AutoScroll>
      </div>
    </div>
  );
}

mountClient({
  name: "Swiss Air Concierge",
  sidebar: ItinerarySidebar,
  theme: {
    bg: "#0d1117",
    primary: "#e35d5b",
    text: "#eef2f6",
    surface: "#161d27",
    border: "#232c38",
  },
  tools: {
    to_flight_assistant: { icon: "\u{2708}", label: "Flight desk" },
    to_hotel_assistant: { icon: "\u{1F3E8}", label: "Hotel desk" },
    to_car_rental_assistant: { icon: "\u{1F697}", label: "Car desk" },
    to_excursion_assistant: { icon: "\u{1F5FA}", label: "Excursions desk" },
    complete_or_escalate: { icon: "\u{21A9}", label: "Back to concierge" },
    confirm_action: { icon: "\u{2705}", label: "Applying change" },
    cancel_action: { icon: "\u{274C}", label: "Discarding change" },
    update_ticket: { icon: "\u{1F39F}", label: "Staging ticket change" },
    cancel_ticket: { icon: "\u{1F5D1}", label: "Staging cancellation" },
    book_hotel: { icon: "\u{1F6CF}", label: "Staging hotel" },
    book_car_rental: { icon: "\u{1F511}", label: "Staging car" },
    book_excursion: { icon: "\u{1F3AB}", label: "Staging excursion" },
  },
});
