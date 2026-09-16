"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, CheckCircle2, Clock3, MapPin, Phone, Scissors } from "lucide-react";
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
  outsideAreaMessage,
  parseDateKey,
  prettyDayLong,
  serviceArea,
  slotId,
  slotTimeKeys,
  travelAreaLabel,
  withinServiceArea,
} from "@/lib/booking";

/** The Google Maps key is optional: without it the address field still works. */
const MAPS_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;

// Minimal shapes for the parts of the Maps API we touch, so we do not need
// to pull in @types/google.maps as a dependency.
type GooglePlace = {
  formatted_address?: string;
  name?: string;
  geometry?: { location?: { lat: () => number; lng: () => number } };
};
type GoogleAutocomplete = {
  addListener: (event: string, handler: () => void) => void;
  getPlace: () => GooglePlace;
};
type GoogleMaps = {
  maps: {
    Circle: new (options: unknown) => { getBounds: () => unknown };
    places: { Autocomplete: new (input: HTMLInputElement, options: unknown) => GoogleAutocomplete };
  };
};

type Suggestion = { label: string; lat: number; lon: number };

type PhotonFeature = {
  properties?: Record<string, string | undefined>;
  geometry?: { coordinates?: number[] };
};

/**
 * Keyless address suggestions from Photon (OpenStreetMap), used when no
 * Google Maps key is configured. Results are biased towards the studio so
 * nearby addresses come first.
 */
const photonLookup = async (query: string, signal: AbortSignal): Promise<Suggestion[]> => {
  const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}`
    + `&lat=${serviceArea.lat}&lon=${serviceArea.lng}&limit=5&lang=en`;
  const response = await fetch(url, { signal });
  const data = await response.json() as { features?: PhotonFeature[] };
  return (data.features || []).map((feature) => {
    const p = feature.properties || {};
    const street = [p.housenumber, p.street].filter(Boolean).join(" ") || p.name || "";
    const label = [street, p.city || p.town || p.village, p.state, p.postcode].filter(Boolean).join(", ");
    const point = feature.geometry?.coordinates;
    if (!label || !point || point.length < 2) return null;
    return { label, lat: point[1], lon: point[0] };
  }).filter((item): item is Suggestion => item !== null);
};

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
  const [location, setLocation] = useState("");
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [locationNote, setLocationNote] = useState("");
  const [mapsReady, setMapsReady] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const addressRef = useRef<HTMLInputElement | null>(null);
  const autocompleteRef = useRef<GoogleAutocomplete | null>(null);
  const skipLookupRef = useRef(false);
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

  // Load the Maps script once, and only when a key is configured. Without a
  // key the address field stays a plain required text input.
  useEffect(() => {
    if (!MAPS_KEY) return;
    if ((window as unknown as { google?: GoogleMaps }).google?.maps?.places) { setMapsReady(true); return; }
    const existing = document.getElementById("sf-google-maps") as HTMLScriptElement | null;
    const onLoad = () => setMapsReady(true);
    if (existing) { existing.addEventListener("load", onLoad); return () => existing.removeEventListener("load", onLoad); }
    const script = document.createElement("script");
    script.id = "sf-google-maps";
    script.src = `https://maps.googleapis.com/maps/api/js?key=${MAPS_KEY}&libraries=places&loading=async`;
    script.async = true;
    script.addEventListener("load", onLoad);
    document.head.appendChild(script);
    return () => script.removeEventListener("load", onLoad);
  }, []);

  // Bind autocomplete, biased to the travel area so nearby addresses surface
  // first. strictBounds keeps suggestions inside that circle.
  useEffect(() => {
    if (!mapsReady || !addressRef.current || autocompleteRef.current) return;
    const google = (window as unknown as { google?: GoogleMaps }).google;
    if (!google?.maps?.places) return;
    const circle = new google.maps.Circle({
      center: { lat: serviceArea.lat, lng: serviceArea.lng },
      radius: serviceArea.suggestRadiusMiles * 1609.34,
    });
    const autocomplete = new google.maps.places.Autocomplete(addressRef.current, {
      componentRestrictions: { country: "us" },
      bounds: circle.getBounds(),
      strictBounds: true,
      fields: ["formatted_address", "name", "geometry"],
    });
    autocomplete.addListener("place_changed", () => {
      const place = autocomplete.getPlace();
      const address = place.formatted_address || place.name || "";
      const point = place.geometry?.location;
      if (address) setLocation(address);
      if (!point) { setCoords(null); setLocationNote(""); return; }
      const lat = point.lat();
      const lng = point.lng();
      setCoords({ lat, lng });
      setLocationNote(withinServiceArea(lat, lng) ? "inside" : outsideAreaMessage(lat, lng));
    });
    autocompleteRef.current = autocomplete;
  }, [mapsReady]);

  // Keyless suggestions. Skipped entirely when Google is driving the field.
  useEffect(() => {
    if (MAPS_KEY) return;
    if (skipLookupRef.current) { skipLookupRef.current = false; return; }
    const query = location.trim();
    if (query.length < 4) { setSuggestions([]); setActiveIndex(-1); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        setSuggestions(await photonLookup(query, controller.signal));
        setActiveIndex(-1);
      } catch {
        // Aborted, or the lookup service is unreachable. Keep what was typed.
      }
    }, 300);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [location]);

  const chooseSuggestion = (suggestion: Suggestion) => {
    skipLookupRef.current = true;
    setLocation(suggestion.label);
    setCoords({ lat: suggestion.lat, lng: suggestion.lon });
    setLocationNote(withinServiceArea(suggestion.lat, suggestion.lon) ? "inside" : outsideAreaMessage(suggestion.lat, suggestion.lon));
    setSuggestions([]);
    setActiveIndex(-1);
  };

  const onAddressKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (suggestions.length === 0) return;
    if (event.key === "ArrowDown") { event.preventDefault(); setActiveIndex((index) => (index + 1) % suggestions.length); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((index) => (index - 1 + suggestions.length) % suggestions.length); }
    else if (event.key === "Enter" && activeIndex >= 0) { event.preventDefault(); chooseSuggestion(suggestions[activeIndex]); }
    else if (event.key === "Escape") { setSuggestions([]); setActiveIndex(-1); }
  };

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
    if (!location.trim()) { setError("Please add the address for this booking."); return; }
    if (coords && !withinServiceArea(coords.lat, coords.lng)) { setError(outsideAreaMessage(coords.lat, coords.lng)); return; }
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
      location: location.trim(),
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
        <div className="booking-field full">
          <label htmlFor="booking-location">{kind === "Pick up" ? "Where should we collect from?" : "Your address"}</label>
          <div className="booking-address">
            <input
              id="booking-location"
              ref={addressRef}
              value={location}
              autoComplete="off"
              placeholder="Start typing your street address…"
              role="combobox"
              aria-expanded={suggestions.length > 0}
              aria-autocomplete="list"
              aria-controls="booking-address-list"
              aria-activedescendant={activeIndex >= 0 ? `booking-address-${activeIndex}` : undefined}
              onChange={(event) => { setLocation(event.target.value); setCoords(null); setLocationNote(""); }}
              onKeyDown={onAddressKeyDown}
              onBlur={() => window.setTimeout(() => { setSuggestions([]); setActiveIndex(-1); }, 140)}
              required
            />
            {suggestions.length > 0 && <ul className="booking-suggest" id="booking-address-list" role="listbox">
              {suggestions.map((suggestion, index) => <li
                key={`${suggestion.label}-${index}`}
                id={`booking-address-${index}`}
                role="option"
                aria-selected={index === activeIndex}
                className={index === activeIndex ? "active" : undefined}
                onMouseEnter={() => setActiveIndex(index)}
                onMouseDown={(event) => { event.preventDefault(); chooseSuggestion(suggestion); }}
              >{suggestion.label}</li>)}
            </ul>}
          </div>
          <em className="booking-hint">
            We travel {travelAreaLabel()}. Pick your address from the suggestions so we can check it.
          </em>
          {locationNote === "inside" && <span className="booking-area ok"><CheckCircle2 size={14} /> That address is inside our travel area.</span>}
          {locationNote && locationNote !== "inside" && <span className="booking-area bad"><MapPin size={14} /> {locationNote}</span>}
        </div>
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
