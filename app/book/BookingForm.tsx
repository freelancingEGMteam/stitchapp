"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Clock3, MapPin, Phone, Scissors } from "lucide-react";
import { supabase } from "@/lib/supabase";
import {
  BookingKind,
  bookingConfig,
  bookingKinds,
  bookableDays,
  formatSlot,
  isSlotAvailable,
  openingHoursLabel,
  prettyDay,
  prettyDayLong,
  slotId,
  slotTimeKeys,
} from "@/lib/booking";

const DAY_CHIPS = 14;

export default function BookingForm() {
  // Dates are resolved on the client only. Rendering them during SSR would
  // produce a different calendar on the server than in the browser and trip
  // a hydration mismatch.
  const [now, setNow] = useState<Date | null>(null);
  const [kind, setKind] = useState<BookingKind>("Drop off");
  const [day, setDay] = useState("");
  const [slot, setSlot] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [notes, setNotes] = useState("");
  const [booked, setBooked] = useState<Set<string>>(new Set());
  const [loadingSlots, setLoadingSlots] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { setNow(new Date()); }, []);

  const days = useMemo(() => (now ? bookableDays(now).slice(0, DAY_CHIPS) : []), [now]);
  const slots = useMemo(() => slotTimeKeys(), []);

  // Open on the first day that actually has a free slot. Landing after hours
  // (or inside the notice window) would otherwise present a dead end.
  useEffect(() => {
    if (day || !now || days.length === 0) return;
    const firstOpen = days.find((key) => slots.some((time) => isSlotAvailable(key, time, booked, now)));
    setDay(firstOpen || days[0]);
  }, [day, now, days, slots, booked]);

  const loadBooked = useCallback(async () => {
    if (!supabase || days.length === 0) { setLoadingSlots(false); return; }
    const { data, error: rpcError } = await supabase.rpc("booked_slots", { from_date: days[0], to_date: days[days.length - 1] });
    if (rpcError) { setLoadingSlots(false); return; }
    const rows = (data || []) as { slot_date: string; slot_time: string }[];
    setBooked(new Set(rows.map((row) => slotId(row.slot_date, row.slot_time))));
    setLoadingSlots(false);
  }, [days]);

  useEffect(() => { void loadBooked(); }, [loadBooked]);

  const available = useMemo(
    () => slots.filter((time) => now && day && isSlotAvailable(day, time, booked, now)),
    [slots, booked, day, now],
  );

  const notesCopy = kind === "Pick up"
    ? { label: "What are you picking up?", placeholder: "e.g. the blue dress I dropped off on Tuesday" }
    : { label: "What are you bringing?", placeholder: "e.g. 2 pairs of trousers to hem, one dress to take in" };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    if (!slot) { setError("Please choose a time slot."); return; }
    if (!supabase) { setError("Online booking is not connected yet. Please call the studio to arrange a time."); return; }
    setSubmitting(true);
    const { error: insertError } = await supabase.from("booking_requests").insert({
      id: `book-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      slot_date: day,
      slot_time: slot,
      kind,
      customer_name: name.trim(),
      phone_number: phone.trim(),
      email: email.trim(),
      notes: notes.trim(),
      status: "Requested",
    });
    setSubmitting(false);
    if (insertError) {
      // 23505 = unique violation, i.e. someone took the slot first.
      if (insertError.code === "23505") {
        setError("Sorry — that slot was just taken. Please pick another time.");
        setSlot("");
        void loadBooked();
      } else {
        setError("We could not save your request. Please try again, or call the studio.");
      }
      return;
    }
    setDone(true);
  };

  if (done) {
    return <div className="booking-card booking-done">
      <CheckCircle2 size={40} className="booking-done-icon" />
      <h2>Request received</h2>
      <p className="booking-lede">
        Thanks {name.split(/\s+/)[0] || "there"} — we have your {kind.toLowerCase()} request for
        <strong> {prettyDayLong(day)} at {formatSlot(slot)}</strong>.
      </p>
      <p className="booking-note">The studio will confirm shortly. If you need to change anything, just call.</p>
    </div>;
  }

  return <form className="booking-card" onSubmit={submit}>
    <div className="booking-kinds" role="group" aria-label="What is this appointment for?">
      {bookingKinds.map((option) => <button
        key={option}
        type="button"
        className={`booking-kind ${kind === option ? "active" : ""}`}
        aria-pressed={kind === option}
        onClick={() => setKind(option)}
      >{option}</button>)}
    </div>

    {!supabase && <div className="booking-alert">
      Online booking is not connected yet. The studio needs to finish setup before requests can be saved.
    </div>}

    <div className="booking-section">
      <h2 className="booking-label">1. Pick a day</h2>
      {!now ? <div className="booking-muted">Loading available days…</div> : <div className="booking-days">
        {days.map((key) => <button
          key={key}
          type="button"
          className={`booking-day ${day === key ? "active" : ""}`}
          aria-pressed={day === key}
          onClick={() => { setDay(key); setSlot(""); }}
        >{prettyDay(key)}</button>)}
      </div>}
    </div>

    <div className="booking-section">
      <h2 className="booking-label">2. Pick a time</h2>
      {loadingSlots ? <div className="booking-muted">Loading available times…</div> : available.length === 0
        ? <div className="booking-muted">No times available on this day. Try another — bookings need at least {bookingConfig.leadHours} hours&apos; notice.</div>
        : <div className="booking-slots">
          {available.map((time) => <button
            key={time}
            type="button"
            className={`booking-slot ${slot === time ? "active" : ""}`}
            aria-pressed={slot === time}
            onClick={() => setSlot(time)}
          >{formatSlot(time)}</button>)}
        </div>}
    </div>

    <div className="booking-section">
      <h2 className="booking-label">3. Your details</h2>
      <div className="booking-fields">
        <label className="booking-field">
          <span>Name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Your name" required />
        </label>
        <label className="booking-field">
          <span>Phone</span>
          <input value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="(555) 123-4567" />
        </label>
        <label className="booking-field">
          <span>Email</span>
          <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" />
        </label>
        <label className="booking-field full">
          <span>{notesCopy.label}</span>
          <textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder={notesCopy.placeholder} />
        </label>
      </div>
    </div>

    {error && <div className="booking-alert error">{error}</div>}

    <button type="submit" className="booking-submit" disabled={submitting || !supabase}>
      {submitting ? "Sending…" : slot ? `Request ${formatSlot(slot)}` : "Request this time"}
    </button>

    <div className="booking-meta">
      <span><Clock3 size={14} /> {openingHoursLabel()}</span>
      <span><Phone size={14} /> If it is urgent, call the studio directly.</span>
    </div>
  </form>;
}

export function BookingHeader() {
  return <header className="booking-header">
    <div className="booking-brand"><Scissors size={20} /></div>
    <h1>Book a drop-off or pick-up</h1>
    <p className="booking-lede">Choose a time that suits you and we will confirm it.</p>
    <div className="booking-meta"><span><MapPin size={14} /> Rachel&apos;s Seamstress Studio</span></div>
  </header>;
}
