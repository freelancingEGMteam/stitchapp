import { NextResponse } from "next/server";
import nodemailer from "nodemailer";

/**
 * Receives a database webhook whenever a booking request is inserted, and
 * emails the studio about it.
 *
 * Deliberately triggered from the database rather than the booking page: a
 * browser tab that closes mid-request, or a booking made any other way, still
 * produces a notification.
 *
 * nodemailer needs Node, so this must not run on the edge runtime.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type BookingRecord = {
  id?: string;
  kind?: string;
  slot_date?: string;
  slot_time?: string;
  customer_name?: string;
  phone_number?: string;
  email?: string;
  location?: string;
  notes?: string;
  status?: string;
};

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** "2026-09-18" + "09:00" -> "Friday, September 18 at 9:00 AM" */
const describeSlot = (date?: string, time?: string) => {
  if (!date) return "date not set";
  const parsed = new Date(`${date}T12:00:00`);
  const day = Number.isNaN(parsed.getTime())
    ? date
    : new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" }).format(parsed);
  if (!time) return day;
  const [hours, minutes] = time.split(":").map(Number);
  const suffix = hours >= 12 ? "PM" : "AM";
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${day} at ${hour12}:${String(minutes).padStart(2, "0")} ${suffix}`;
};

export async function POST(request: Request) {
  const secret = process.env.NOTIFY_SECRET;
  if (!secret) {
    console.error("[notify] NOTIFY_SECRET is not set; refusing the request");
    return NextResponse.json({ error: "not configured" }, { status: 503 });
  }
  if (request.headers.get("x-notify-secret") !== secret) {
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  }

  let booking: BookingRecord;
  try {
    const payload = await request.json();
    booking = (payload?.record ?? {}) as BookingRecord;
  } catch {
    return NextResponse.json({ error: "bad payload" }, { status: 400 });
  }
  if (!booking.customer_name) return NextResponse.json({ error: "no booking in payload" }, { status: 400 });

  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    console.error("[notify] GMAIL_USER / GMAIL_APP_PASSWORD are not set");
    return NextResponse.json({ error: "email not configured" }, { status: 503 });
  }

  const kind = booking.kind || "Drop off";
  const when = describeSlot(booking.slot_date, booking.slot_time);
  const subject = `New ${kind.toLowerCase()} request — ${booking.customer_name}, ${when}`;

  const rows: [string, string | undefined][] = [
    ["Customer", booking.customer_name],
    ["Type", kind],
    ["When", when],
    ["Phone", booking.phone_number],
    ["Email", booking.email],
    ["Address", booking.location],
    ["Notes", booking.notes],
  ];
  const filled = rows.filter(([, value]) => value && String(value).trim());

  const text = [
    `A new ${kind.toLowerCase()} request came in through the booking page.`,
    "",
    ...filled.map(([label, value]) => `${label}: ${value}`),
    "",
    "Confirm or decline it in the app under Bookings.",
    process.env.NOTIFY_APP_URL ? `${process.env.NOTIFY_APP_URL}` : "",
  ].filter(Boolean).join("\n");

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;color:#2b2622;line-height:1.5">
  <p style="margin:0 0 14px">A new <strong>${escapeHtml(kind.toLowerCase())}</strong> request came in through the booking page.</p>
  <table style="border-collapse:collapse">
    ${filled.map(([label, value]) => `<tr>
      <td style="padding:4px 14px 4px 0;color:#8b837b;vertical-align:top">${escapeHtml(label)}</td>
      <td style="padding:4px 0;font-weight:600">${escapeHtml(String(value))}</td>
    </tr>`).join("")}
  </table>
  <p style="margin:16px 0 0">${
    process.env.NOTIFY_APP_URL
      ? `<a href="${escapeHtml(process.env.NOTIFY_APP_URL)}" style="color:#b5695f">Confirm or decline it in the app</a>`
      : "Confirm or decline it in the app under Bookings."
  }</p>
</div>`;

  try {
    const transport = nodemailer.createTransport({ service: "gmail", auth: { user, pass } });
    await transport.sendMail({
      from: `Stitch & Thread <${user}>`,
      to: process.env.NOTIFY_TO || user,
      subject,
      text,
      html,
    });
    console.log(`[notify] emailed the studio about ${booking.id ?? "a booking"}`);
    return NextResponse.json({ ok: true });
  } catch (error) {
    // Return a failure so pg_net records it, and keep the detail in the logs.
    console.error("[notify] could not send:", error);
    return NextResponse.json({ error: "send failed" }, { status: 502 });
  }
}
