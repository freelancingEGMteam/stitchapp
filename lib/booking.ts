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

/** Open days from tomorrow up to the horizon. */
export const bookableDays = (now = new Date()): string[] => {
  const out: string[] = [];
  for (let offset = 0; offset <= bookingConfig.horizonDays; offset += 1) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    if (isOpenDay(day)) out.push(dateKey(day));
  }
  return out;
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
