export type BookingKind = "Drop off" | "Pick up";

export const bookingKinds: BookingKind[] = ["Drop off", "Pick up"];

/**
 * Studio booking rules. Slot times are the studio's own wall-clock times;
 * this assumes customers book within the same timezone, which is the
 * normal case for a local alterations studio.
 */
export const bookingConfig = {
  slotMinutes: 30,
  openTime: "09:00",
  closeTime: "17:00",
  /** 0 = Sunday, so [2,3,4,5,6] is Tuesday through Saturday. */
  openDays: [2, 3, 4, 5, 6],
  /** Nothing can be booked with less notice than this. */
  leadHours: 12,
  /**
   * When false, the earliest bookable day is tomorrow. Today is left out
   * because the notice period above would rule its slots out anyway;
   * set true if the notice is ever lowered to allow same-day bookings.
   */
  allowSameDay: false,
  /** How far ahead the public page will offer slots. */
  horizonDays: 60,
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

/** Canonical 24h slot keys, e.g. ["09:00", "09:30", ...] */
export const slotTimeKeys = (): string[] => {
  const out: string[] = [];
  const open = toMinutes(bookingConfig.openTime);
  const close = toMinutes(bookingConfig.closeTime);
  for (let t = open; t + bookingConfig.slotMinutes <= close; t += bookingConfig.slotMinutes) {
    out.push(`${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`);
  }
  return out;
};

/** Local YYYY-MM-DD, avoiding the UTC shift that toISOString() introduces. */
export const dateKey = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

export const parseDateKey = (key: string) => {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day);
};

export const isOpenDay = (date: Date) => bookingConfig.openDays.includes(date.getDay());

export const slotDateTime = (dayKey: string, slot: string) => {
  const day = parseDateKey(dayKey);
  const [hours, minutes] = slot.split(":").map(Number);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours, minutes, 0, 0);
};

export const slotId = (dayKey: string, slot: string) => `${dayKey} ${slot}`;

/** Open days from tomorrow (or today when allowSameDay) up to the horizon. */
export const bookableDays = (now = new Date()): string[] => {
  const out: string[] = [];
  const start = bookingConfig.allowSameDay ? 0 : 1;
  for (let offset = start; offset <= bookingConfig.horizonDays + start; offset += 1) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    if (isOpenDay(day)) out.push(dateKey(day));
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

export const isSlotAvailable = (dayKey: string, slot: string, booked: Set<string>, now = new Date()) => {
  if (booked.has(slotId(dayKey, slot))) return false;
  const earliest = new Date(now.getTime() + bookingConfig.leadHours * 60 * 60 * 1000);
  return slotDateTime(dayKey, slot) >= earliest;
};

export const prettyDay = (key: string) =>
  new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" }).format(parseDateKey(key));

export const prettyDayLong = (key: string) =>
  new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" }).format(parseDateKey(key));

export const openingHoursLabel = () => {
  const days = [...bookingConfig.openDays].sort((a, b) => a - b);
  const contiguous = days.every((day, index) => index === 0 || day === days[index - 1] + 1);
  const label = days.length > 1 && contiguous
    ? `${dayNames[days[0]].slice(0, 3)}–${dayNames[days[days.length - 1]].slice(0, 3)}`
    : days.map((day) => dayNames[day].slice(0, 3)).join(", ");
  return `${label} · ${formatSlot(bookingConfig.openTime)} – ${formatSlot(bookingConfig.closeTime)}`;
};

/** e.g. "Closed Sundays and Mondays." — empty when open every day. */
export const closedDaysLabel = () => {
  const closed = [0, 1, 2, 3, 4, 5, 6].filter((day) => !bookingConfig.openDays.includes(day));
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
