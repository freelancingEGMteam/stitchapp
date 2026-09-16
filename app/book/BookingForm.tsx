"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarDays, CheckCircle2, Clock3, Phone, Scissors } from "lucide-react";
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
  // Dates resolve on the client only. Rendering them during SSR would produce
  // a different calendar on the server than in the browser and trip a
  // hydration mismatch.
  const [now, setNow] = useState<Date | null>(null);
  const [kind, setKind] = useState<BookingKind>("Drop off");
  const [day, setDay] = useState("");
  const [slot, setSlot] = useState("");
  const [stage, setStage] = useState<"pick" | "details">("pick");
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

  // Month cursor as year*12+month, so it compares as a plain number.
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
        setStage("pick");
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

  return <form className="booking-card booking-grid" onSubmit={submit}>
    {!supabase && <div className="booking-alert">
      Online booking is not connected yet. The studio needs to finish setup before requests can be saved.
    </div>}
    <aside className="booking-aside">
      <div className="booking-aside-brand"><Scissors size={17} /> Rachel&apos;s Seamstress Studio</div>
      <div className="booking-aside-label">Appointment type</div>
      <div className="booking-kinds" role="group" aria-label="Appointment type">
        {bookingKinds.map((option) => <button
          key={option}
          type="button"
          className={`booking-kind ${kind === option ? "active" : ""}`}
          aria-pressed={kind === option}
          onClick={() => setKind(option)}
        ><span className="booking-kind-dot" aria-hidden="true" />{option}</button>)}
      </div>
      <ul className="booking-facts">
        <li><Clock3 size={14} /> {bookingConfig.slotMinutes} min</li>
        <li><CalendarDays size={14} /> {openingHoursLabel()}</li>
      </ul>
      <p className="booking-aside-note">{closedDaysLabel()}</p>
    </aside>

    <div className="booking-picker">
      <section className="booking-cal-col">
        <h2 className="booking-picker-title">Select a Date &amp; Time</h2>
        {cursor === null ? <div className="booking-muted">Loading available days…</div> : <>
          <div className="booking-cal-head">
            <button type="button" className="booking-cal-nav" aria-label="Previous month" disabled={cursor <= firstMonth} onClick={() => setCursor(cursor - 1)}>‹</button>
            <div className="booking-cal-title">{monthTitle(Math.floor(cursor / 12), cursor % 12)}</div>
            <button type="button" className="booking-cal-nav" aria-label="Next month" disabled={cursor >= lastMonth} onClick={() => setCursor(cursor + 1)}>›</button>
          </div>
          <div className="booking-cal-dow">{["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"].map((label) => <span key={label}>{label}</span>)}</div>
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
                onClick={() => { setDay(key); setSlot(""); setStage("pick"); }}
              >{parseDateKey(key).getDate()}</button>;
            })}
          </div>
          <div className="booking-tz"><Clock3 size={13} /> Times are the studio&apos;s local time.</div>
        </>}
      </section>

      <section className="booking-times-col">
        <div className="booking-times-head">{day ? prettyDayLong(day) : "Pick a day"}</div>
        {loadingSlots ? <div className="booking-muted">Loading times…</div> : available.length === 0
          ? <div className="booking-muted">No times available. Try another day.</div>
          : <div className="booking-times">
            {available.map((time) => {
              const selected = slot === time;
              const confirming = selected && stage === "pick";
              return <button
                key={time}
                type="button"
                className={`booking-time${selected ? " active" : ""}${confirming ? " confirming" : ""}`}
                aria-pressed={selected}
                title={confirming ? "Click again to confirm this time" : `Choose ${formatSlot(time)}`}
                onClick={() => {
                  if (selected && stage === "pick") { setStage("details"); return; }
                  setSlot(time);
                  setStage("pick");
                }}
              >
                <span className="booking-time-label">{formatSlot(time)}</span>
                {confirming && <span className="booking-time-confirm">Confirm</span>}
              </button>;
            })}
          </div>}
      </section>
    </div>

    {stage === "details" && <section className="booking-details">
      <h2 className="booking-picker-title">Your details</h2>
      <div className="booking-summary">
        <span>{kind}</span><span>·</span><span>{prettyDayLong(day)}</span><span>·</span><span>{formatSlot(slot)}</span>
      </div>
      <div className="booking-fields">
        <label className="booking-field"><span>Name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Your name" required /></label>
        <label className="booking-field"><span>Phone</span>
          <input value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="(555) 123-4567" /></label>
        <label className="booking-field"><span>Email</span>
          <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" /></label>
        <label className="booking-field full"><span>{notesCopy.label}</span>
          <textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder={notesCopy.placeholder} /></label>
      </div>
      {error && <div className="booking-alert error">{error}</div>}
      <button type="submit" className="booking-submit" disabled={submitting || !supabase}>
        {submitting ? "Sending…" : "Schedule Event"}
      </button>
      <button type="button" className="booking-back" onClick={() => setStage("pick")}>← Pick a different time</button>
    </section>}

    {stage === "pick" && error && <div className="booking-alert error">{error}</div>}
    <div className="booking-meta"><span><Phone size={14} /> If it is urgent, call the studio directly.</span></div>
  </form>;
}

export function BookingHeader() {
  return <header className="booking-header">
    <div className="booking-header-brand"><Scissors size={20} /></div>
    <h1>Book a drop-off or pick-up</h1>
    <p className="booking-lede">Choose a time that suits you and we&apos;ll confirm it.</p>
  </header>;
}
