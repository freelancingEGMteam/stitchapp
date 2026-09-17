export type BookingKind = "Drop off" | "Pick up";

export const bookingKinds: BookingKind[] = ["Drop off", "Pick up"];

/** One day's window, or null when the studio is closed that day. */
export type DayHours = { open: string; close: string } | null;

/**
 * Studio booking rules. Slot times are the studio's own wall-clock times;
 * this assumes customers book within the same timezone, which is the
 * normal case for a local alterations studio.
 *
 * Hours are per day, because this is not a fixed shop: Tuesday might be
 * 4-6pm while Wednesday is 9-5.
 *
 * These are the defaults. The studio can change them from the Bookings
 * screen, and the saved values are what the public page uses.
 */
export type BookingRules = {
  slotMinutes: number;
  /** Seven entries, index 0 = Sunday. null means closed that day. */
  dayHours: DayHours[];
  /** Nothing can be booked with less notice than this. */
  leadHours: number;
  /**
   * When false, the earliest bookable day is tomorrow. Today is left out
   * because the notice period above would rule its slots out anyway;
   * set true if the notice is ever lowered to allow same-day bookings.
   */
  allowSameDay: boolean;
  /** How far ahead the public page will offer slots. */
  horizonDays: number;
};

const openNineToFive: DayHours = { open: "09:00", close: "17:00" };

export const bookingConfig: BookingRules = {
  slotMinutes: 30,
  // Sunday and Saturday closed; Monday to Friday 9-5.
  dayHours: [null, openNineToFive, openNineToFive, openNineToFive, openNineToFive, openNineToFive, null],
  leadHours: 12,
  allowSameDay: false,
  horizonDays: 60,
};

const isClock = (value: unknown) => typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
const clamp = (value: unknown, low: number, high: number, fallback: number) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(high, Math.max(low, Math.round(n))) : fallback;
};

/** Accepts only a well-formed 7-entry week; anything else is rejected whole. */
const parseDayHours = (value: unknown): DayHours[] | null => {
  if (!Array.isArray(value) || value.length !== 7) return null;
  const out: DayHours[] = [];
  for (const entry of value) {
    if (entry === null) { out.push(null); continue; }
    if (typeof entry !== "object") return null;
    const open = (entry as Record<string, unknown>).open;
    const close = (entry as Record<string, unknown>).close;
    if (!isClock(open) || !isClock(close)) return null;
    if (toMinutes(String(close)) <= toMinutes(String(open))) return null;
    out.push({ open: String(open), close: String(close) });
  }
  return out;
};

/** Rebuilds a week from the older single-window columns, for rows not migrated yet. */
const legacyDayHours = (row: Record<string, unknown>): DayHours[] => {
  const days = Array.isArray(row.open_days)
    ? row.open_days.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    : [];
  if (days.length === 0) return bookingConfig.dayHours;
  const open = isClock(row.open_time) ? String(row.open_time) : "09:00";
  const rawClose = isClock(row.close_time) ? String(row.close_time) : "17:00";
  const close = toMinutes(rawClose) > toMinutes(open) ? rawClose : "17:00";
  return [0, 1, 2, 3, 4, 5, 6].map((day) => (days.includes(day) ? { open, close } : null));
};

/**
 * Turns a row from booking_settings into usable rules, discarding anything
 * malformed rather than letting bad data break the public page.
 */
export const bookingRulesFrom = (row: Record<string, unknown> | null | undefined): BookingRules => {
  if (!row) return bookingConfig;
  return {
    slotMinutes: clamp(row.slot_minutes, 5, 240, bookingConfig.slotMinutes),
    dayHours: parseDayHours(row.day_hours) ?? legacyDayHours(row),
    leadHours: clamp(row.lead_hours, 0, 336, bookingConfig.leadHours),
    allowSameDay: row.allow_same_day === true,
    horizonDays: clamp(row.horizon_days, 1, 365, bookingConfig.horizonDays),
  };
};

export const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export const toMinutes = (time: string) => {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
};

/** "09:30" -> "9:30 AM" */
export const formatSlot = (time: string) => {
  const [hours, minutes] = time.split(":").map(Number);
  const suffix = hours >= 12 ? "PM" : "AM";
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${hour12}:${String(minutes).padStart(2, "0")} ${suffix}`;
};

/**
 * Canonical 24h slot keys for one weekday, e.g. ["09:00", "09:30", ...].
 * Empty when the studio is closed that day. `dayIndex` is 0 = Sunday.
 */
export const slotTimeKeys = (dayIndex: number, rules: BookingRules = bookingConfig): string[] => {
  const hours = rules.dayHours[dayIndex];
  if (!hours) return [];
  const out: string[] = [];
  const open = toMinutes(hours.open);
  const close = toMinutes(hours.close);
  for (let t = open; t + rules.slotMinutes <= close; t += rules.slotMinutes) {
    out.push(`${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`);
  }
  return out;
};

/** Slots for a specific date key. */
export const slotTimeKeysForDay = (dayKey: string, rules: BookingRules = bookingConfig) =>
  slotTimeKeys(parseDateKey(dayKey).getDay(), rules);

/** Local YYYY-MM-DD, avoiding the UTC shift that toISOString() introduces. */
export const dateKey = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

export const parseDateKey = (key: string) => {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day);
};

export const isOpenDay = (date: Date, rules: BookingRules = bookingConfig) => rules.dayHours[date.getDay()] !== null;

export const slotDateTime = (dayKey: string, slot: string) => {
  const day = parseDateKey(dayKey);
  const [hours, minutes] = slot.split(":").map(Number);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours, minutes, 0, 0);
};

export const slotId = (dayKey: string, slot: string) => `${dayKey} ${slot}`;

/** Open days from tomorrow (or today when allowSameDay) up to the horizon. */
export const bookableDays = (now = new Date(), rules: BookingRules = bookingConfig): string[] => {
  const out: string[] = [];
  const start = rules.allowSameDay ? 0 : 1;
  for (let offset = start; offset <= rules.horizonDays + start; offset += 1) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    if (isOpenDay(day, rules)) out.push(dateKey(day));
  }
  return out;
};

/** Six weeks of date keys covering the month, beginning on a Sunday. */
export const monthGrid = (year: number, month: number): string[] => {
  const first = new Date(year, month, 1);
  const start = new Date(year, month, 1 - first.getDay());
  return Array.from({ length: 42 }, (_, index) =>
    dateKey(new Date(start.getFullYear(), start.getMonth(), start.getDate() + index)));
};

export const monthTitle = (year: number, month: number) =>
  new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(new Date(year, month, 1));

export const monthIndexOf = (key: string) => {
  const day = parseDateKey(key);
  return day.getFullYear() * 12 + day.getMonth();
};

export const isSlotAvailable = (dayKey: string, slot: string, booked: Set<string>, now = new Date(), rules: BookingRules = bookingConfig) => {
  if (booked.has(slotId(dayKey, slot))) return false;
  const earliest = new Date(now.getTime() + rules.leadHours * 60 * 60 * 1000);
  return slotDateTime(dayKey, slot) >= earliest;
};

export const prettyDay = (key: string) =>
  new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" }).format(parseDateKey(key));

export const prettyDayLong = (key: string) =>
  new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" }).format(parseDateKey(key));

/** e.g. "Tue–Fri · 9:00 AM – 5:00 PM", or "… · hours vary by day". */
export const openingHoursLabel = (rules: BookingRules = bookingConfig) => {
  const open = rules.dayHours.map((hours, day) => ({ day, hours })).filter((entry) => entry.hours !== null);
  if (open.length === 0) return "No open days set";
  const first = open[0].hours!;
  const uniform = open.every((entry) => entry.hours!.open === first.open && entry.hours!.close === first.close);
  const days = open.map((entry) => entry.day);
  const contiguous = days.every((day, index) => index === 0 || day === days[index - 1] + 1);
  const dayLabel = days.length > 1 && contiguous
    ? `${dayNames[days[0]].slice(0, 3)}–${dayNames[days[days.length - 1]].slice(0, 3)}`
    : days.map((day) => dayNames[day].slice(0, 3)).join(", ");
  if (!uniform) return `${dayLabel} · hours vary by day`;
  return `${dayLabel} · ${formatSlot(first.open)} – ${formatSlot(first.close)}`;
};

/** Open days with their windows, in week order, for showing a full week. */
export const weeklyHours = (rules: BookingRules = bookingConfig) =>
  rules.dayHours
    .map((hours, day) => ({ day, label: dayNames[day], hours }))
    .filter((entry): entry is { day: number; label: string; hours: { open: string; close: string } } => entry.hours !== null);

/** e.g. "Closed Saturdays and Sundays." — empty when open every day. */
export const closedDaysLabel = (rules: BookingRules = bookingConfig) => {
  // Week order starting Monday, so two closed days read "Saturdays and Sundays".
  const closed = [1, 2, 3, 4, 5, 6, 0].filter((day) => rules.dayHours[day] === null);
  if (closed.length === 0) return "";
  return `Closed ${closed.map((day) => `${dayNames[day]}s`).join(" and ")}.`;
};

/**
 * Where the studio will travel to. Coordinates are the centroid of ZIP
 * 03446 (Swanzey, NH) from OpenStreetMap.
 */
export const serviceArea = {
  zip: "03446",
  label: "Swanzey, NH 03446",
  lat: 42.8667733,
  lng: -72.2923595,
  /** Address suggestions are biased inside this radius. */
  suggestRadiusMiles: 25,
  /** Stated to the customer as a drive time. */
  maxDriveMinutes: 20,
  /**
   * The drive time is enforced as a straight-line radius, because real
   * drive time needs the Distance Matrix API. Around Swanzey, 15 miles
   * is roughly 20 minutes on local roads. Raise or lower to taste.
   */
  maxRadiusMiles: 15,
};

/** Great-circle distance in miles. */
export const milesBetween = (lat1: number, lng1: number, lat2: number, lng2: number) => {
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const earthRadiusMiles = 3958.8;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * earthRadiusMiles * Math.asin(Math.sqrt(a));
};

export const milesFromStudio = (lat: number, lng: number) =>
  milesBetween(serviceArea.lat, serviceArea.lng, lat, lng);

export const withinServiceArea = (lat: number, lng: number) =>
  milesFromStudio(lat, lng) <= serviceArea.maxRadiusMiles;

export const travelAreaLabel = () =>
  `within a ${serviceArea.maxDriveMinutes}-minute drive of ${serviceArea.label}`;

/** The message shown when an address falls outside the travel area. */
export const outsideAreaMessage = (lat: number, lng: number) => {
  const miles = milesFromStudio(lat, lng);
  return `That address is about ${Math.round(miles)} miles from the studio, outside our ${serviceArea.maxDriveMinutes}-minute area around ${serviceArea.label}. Call the studio and we will see what we can do.`;
};
