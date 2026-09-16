"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, CheckCircle2, Clock3, MapPin, Phone, Scissors } from "lucide-react";
import { supabase } from "@/lib/supabase";
import {
  BookingKind,
  BookingRules,
  bookingConfig,
  bookingKinds,
  bookingRulesFrom,
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
//
// These follow the current Places API (Autocomplete Data). The legacy
// google.maps.places.Autocomplete widget is NOT available to new Google
// Cloud projects, so binding to an <input> is no longer an option. The
// programmatic API also lets us keep our own styled suggestion list.
type GoogleLatLng = { lat: () => number; lng: () => number };
type GooglePlace = {
  formattedAddress?: string;
  displayName?: string;
  location?: GoogleLatLng;
  fetchFields: (options: { fields: string[] }) => Promise<void>;
};
type GooglePrediction = {
  text?: { text?: string };
  mainText?: { text?: string };
  toPlace: () => GooglePlace;
};
type GooglePlacesLibrary = {
  AutocompleteSuggestion: {
    fetchAutocompleteSuggestions: (request: unknown) => Promise<{ suggestions?: { placePrediction?: GooglePrediction }[] }>;
  };
};
type GoogleMapsNamespace = { importLibrary: (name: string) => Promise<GooglePlacesLibrary> };

/** `prediction` is set for Google results; `lat`/`lon` for Photon results. */
type Suggestion = { label: string; lat?: number; lon?: number; prediction?: GooglePrediction };

const loadGooglePlaces = async (): Promise<GooglePlacesLibrary | null> => {
  const google = (window as unknown as { google?: { maps?: GoogleMapsNamespace } }).google;
  if (!google?.maps?.importLibrary) return null;
  try {
    return await google.maps.importLibrary("places");
  } catch {
    return null;
  }
};

/** Google Places suggestions, biased to the studio's travel area. */
const lookupWithGoogle = async (query: string, signal: AbortSignal): Promise<Suggestion[]> => {
  const places = await loadGooglePlaces();
  if (!places || signal.aborted) return [];
  const { suggestions } = await places.AutocompleteSuggestion.fetchAutocompleteSuggestions({
    input: query,
    includedRegionCodes: ["us"],
    locationBias: {
      center: { lat: serviceArea.lat, lng: serviceArea.lng },
      radius: serviceArea.suggestRadiusMiles * 1609.34,
    },
  });
  return (suggestions || []).map((entry): Suggestion | null => {
    const prediction = entry.placePrediction;
    const label = prediction?.text?.text || prediction?.mainText?.text || "";
    return label && prediction ? { label, prediction } : null;
  }).filter((item): item is Suggestion => item !== null);
};

type PhotonFeature = {
  properties?: Record<string, string | undefined>;
  geometry?: { coordinates?: number[] };
};

/**
 * Keyless fallback using Photon (OpenStreetMap), for when no Google Maps key
 * is configured. Results are biased towards the studio so nearby addresses
 * come first.
 */
const photonLookup = async (query: string, signal: AbortSignal): Promise<Suggestion[]> => {
  const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}`
    + `&lat=${serviceArea.lat}&lon=${serviceArea.lng}&limit=5&lang=en`;
  const response = await fetch(url, { signal });
  const data = await response.json() as { features?: PhotonFeature[] };
  return (data.features || []).map((feature): Suggestion | null => {
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
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const addressRef = useRef<HTMLInputElement | null>(null);
  const skipLookupRef = useRef(false);
  const [booked, setBooked] = useState<Set<string>>(new Set());
  const [loadingSlots, setLoadingSlots] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { setNow(new Date()); }, []);

  const [rules, setRules] = useState<BookingRules>(bookingConfig);
  useEffect(() => {
    if (!supabase) return;
    let cancelled = false;
    void supabase.from("booking_settings").select("*").eq("id", "default").maybeSingle().then(({ data }) => {
      if (!cancelled && data) setRules(bookingRulesFrom(data as Record<string, unknown>));
    });
    return () => { cancelled = true; };
  }, []);

  const bookable = useMemo(() => (now ? bookableDays(now, rules) : []), [now, rules]);
  const slots = useMemo(() => slotTimeKeys(rules), [rules]);

  // Days that are open AND still have at least one free slot. Offering a day
  // with nothing left on it only leads the customer into a dead end.
  const daysWithSlots = useMemo(() => {
    const set = new Set<string>();
    if (!now) return set;
    for (const key of bookable) {
      if (slots.some((time) => isSlotAvailable(key, time, booked, now, rules))) set.add(key);
    }
    return set;
  }, [bookable, slots, booked, now, rules]);

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

  // Load the Maps bootstrap once, and only when a key is configured. The
  // Places library itself is pulled in on demand by loadGooglePlaces().
  useEffect(() => {
    if (!MAPS_KEY) return;
    if (document.getElementById("sf-google-maps")) return;
    const script = document.createElement("script");
    script.id = "sf-google-maps";
    script.src = `https://maps.googleapis.com/maps/api/js?key=${MAPS_KEY}&libraries=places&loading=async&v=weekly`;
    script.async = true;
    document.head.appendChild(script);
  }, []);

  // One lookup path for both providers. Google when a key is configured,
  // otherwise the keyless Photon service. Debounced, and cancelled when the
  // query changes so stale results never land.
  useEffect(() => {
    if (skipLookupRef.current) { skipLookupRef.current = false; return; }
    const query = location.trim();
    if (query.length < 4) { setSuggestions([]); setActiveIndex(-1); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const found = MAPS_KEY
          ? await lookupWithGoogle(query, controller.signal)
          : await photonLookup(query, controller.signal);
        if (controller.signal.aborted) return;
        setSuggestions(found);
        setActiveIndex(-1);
      } catch {
        // Aborted, or the lookup service is unreachable. Keep what was typed.
      }
    }, 300);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [location]);

  const chooseSuggestion = async (suggestion: Suggestion) => {
    skipLookupRef.current = true;
    setSuggestions([]);
    setActiveIndex(-1);

    let label = suggestion.label;
    let point = suggestion.lat !== undefined && suggestion.lon !== undefined
      ? { lat: suggestion.lat, lng: suggestion.lon }
      : null;

    // Google returns a prediction; the coordinates need a second call.
    if (!point && suggestion.prediction) {
      try {
        const place = suggestion.prediction.toPlace();
        await place.fetchFields({ fields: ["formattedAddress", "location"] });
        if (place.location) point = { lat: place.location.lat(), lng: place.location.lng() };
        if (place.formattedAddress) label = place.formattedAddress;
      } catch {
        // Leave the typed value; the studio can confirm the address later.
      }
    }

    setLocation(label);
    if (point) {
      setCoords(point);
      setLocationNote(withinServiceArea(point.lat, point.lng) ? "inside" : outsideAreaMessage(point.lat, point.lng));
    } else {
      setCoords(null);
      setLocationNote("");
    }
  };

  const onAddressKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (suggestions.length === 0) return;
    if (event.key === "ArrowDown") { event.preventDefault(); setActiveIndex((index) => (index + 1) % suggestions.length); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((index) => (index - 1 + suggestions.length) % suggestions.length); }
    else if (event.key === "Enter" && activeIndex >= 0) { event.preventDefault(); void chooseSuggestion(suggestions[activeIndex]); }
    else if (event.key === "Escape") { setSuggestions([]); setActiveIndex(-1); }
  };

  const available = useMemo(
    () => slots.filter((time) => now && day && isSlotAvailable(day, time, booked, now, rules)),
    [slots, booked, day, now, rules],
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
        <li><Clock3 size={14} /> {rules.slotMinutes} min</li>
        <li><CalendarDays size={14} /> {openingHoursLabel(rules)}</li>
      </ul>
      <p className="booking-aside-note">{closedDaysLabel(rules)}</p>
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
      </div>
      <div className="booking-pair">
        <div className="booking-field booking-field-address">
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
                onMouseDown={(event) => { event.preventDefault(); void chooseSuggestion(suggestion); }}
              >{suggestion.label}</li>)}
            </ul>}
          </div>
          <em className="booking-hint">
            We travel {travelAreaLabel()}. Pick from the suggestions so we can check it.
          </em>
          {locationNote === "inside" && <span className="booking-area ok"><CheckCircle2 size={14} /> That address is inside our travel area.</span>}
          {locationNote && locationNote !== "inside" && <span className="booking-area bad"><MapPin size={14} /> {locationNote}</span>}
        </div>
        <label className="booking-field"><span>{notesCopy.label}</span>
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
