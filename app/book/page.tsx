import type { Metadata } from "next";
import BookingForm, { BookingHeader } from "./BookingForm";

export const metadata: Metadata = {
  title: "Book a drop-off or pick-up · Stitch & Thread",
  description: "Choose a time for your drop-off or pick-up at Rachel's Seamstress Studio.",
};

export default function BookPage() {
  return <div className="booking-shell">
    <BookingHeader />
    <BookingForm />
    <footer className="booking-footer">Times shown are the studio&apos;s local time.</footer>
  </div>;
}
