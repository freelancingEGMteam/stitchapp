"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Clock3, MapPin, Phone, Scissors } from "lucide-react";
import { supabase } from "@/lib/supabase";
import {
  BookingKind,
  bookingConfig,
  bookingKinds,
  bookableDays,
  closedDaysLabel,
  formatSlot,
  isSlotAvailable,
  monthGrid,
  monthIndexOf,
  monthTitle,
  openingHoursLabel,
  parseDateKey,
  prettyDayLong,
  slotId,
  slotTimeKeys,
} from "@/lib/booking";

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

  const bookable = useMemo(() => (now ? bookableDays(now) : []), [now]);
  const slots = useMemo(() => slotTimeKeys(), []);

  // Days that are open AND still have at least one free slot. Offering a day
  // with nothing left on it only leads the customer into a dead end.
  const daysWithSlots = useMemo(() => {
    const set = new Set<string>();
    if (!now) return set;
    for (const key of bookable) {
      if (slots.some((time) => isSlotAvailable(key, time, booked, now))) set.add(key);
    }
    return set;
  }, [bookable, slots, booked, now]);

  // Open on the first day that actually has availability.
  useEffect(() => {
    if (day || !now || bookable.length === 0) return;
    setDay(bookable.find((key) => daysWithSlots.has(key)) || bookable[0]);
  }, [day, now, bookable, daysWithSlots]);

  const loadBooked = useCallback(async () => {
    if (!supabase || bookable.length === 0) { setLoadingSlots(false); return; }
    const { data, error: rpcError } = await supabase.rpc("booked_slots", { from_date: bookable[0], to_date: bookable[bookable.length - 1] });
    if (rpcError) { setLoadingSlots(false); return; }
    const rows = (data || []) as { slot_date: string; slot_time: string }[];
    setBooked(new Set(rows.map((row) => slotId(row.slot_date, row.slot_time))));
    setLoadingSlots(false);
  }, [bookable]);

  useEffect(() => { void loadBooked(); }, [loadBooked]);

  // Month cursor, stored as year*12+month so it compares as a plain number.
  const [cursor, setCursor] = useState<number | null>(null);
  useEffect(() => {
    if (cursor === null && day) setCursor(monthIndexOf(day));
  }, [cursor, day]);

  const firstMonth = bookable.length ? monthIndexOf(bookable[0]) : 0;
  const lastMonth = bookable.length ? monthIndexOf(bookable[bookable.length - 1]) : 0;
  const cells = useMemo(() => (cursor === null ? [] : monthGrid(Math.floor(cursor / 12), cursor % 12)), [cursor]);

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
      {cursor === null ? <div className="booking-muted">Loading available days…</div> : <div className="booking-cal">
        <div className="booking-cal-head">
          <button type="button" className="booking-cal-nav" aria-label="Previous month" disabled={cursor <= firstMonth} onClick={() => setCursor(cursor - 1)}>‹</button>
          <div className="booking-cal-title">{monthTitle(Math.floor(cursor / 12), cursor % 12)}</div>
          <button type="button" className="booking-cal-nav" aria-label="Next month" disabled={cursor >= lastMonth} onClick={() => setCursor(cursor + 1)}>›</button>
        </div>
        <div className="booking-cal-dow">{["S", "M", "T", "W", "T", "F", "S"].map((label, index) => <span key={index}>{label}</span>)}</div>
        <div className="booking-cal-grid">
          {cells.map((key) => {
            const inMonth = monthIndexOf(key) === cursor;
            const selectable = inMonth && daysWithSlots.has(key);
            const isSelected = key === day;
            return <button
              key={key}
              type="button"
              aria-label={prettyDayLong(key)}
              aria-pressed={isSelected}
              disabled={!selectable}
              className={`booking-cal-day${isSelected ? " active" : ""}${selectable ? "" : " off"}${inMonth ? "" : " outside"}`}
              onClick={() => { setDay(key); setSlot(""); }}
            >{parseDateKey(key).getDate()}</button>;
          })}
        </div>
        <div className="booking-cal-hint">{closedDaysLabel()}{bookingConfig.allowSameDay ? "" : " Bookings start tomorrow."}</div>
      </div>}
    </div>

    <div className="booking-section">
      <h2 className="booking-label">2. Pick a time{day ? ` · ${prettyDayLong(day)}` : ""}</h2>
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
