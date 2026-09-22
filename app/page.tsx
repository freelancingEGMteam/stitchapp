"use client";

import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import {
  AlarmClock,
  ArrowUpRight,
  ArrowLeft,
  CalendarCheck,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  CircleDollarSign,
  ClipboardList,
  Clock3,
  FileDown,
  LayoutDashboard,
  ListFilter,
  Menu,
  Mail,
  MapPin,
  PackageCheck,
  Pencil,
  Phone,
  Plus,
  Search,
  Scissors,
  Shirt,
  Sparkles,
  Tag,
  Trash2,
  UserRound,
  UsersRound,
  WalletCards,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { AppData, Customer, Expense, Job, Lead, Lifecycle, Appointment, fullDate, initials, money, seedData, shortDate, statusTone } from "@/lib/data";
import { BookingRules, bookingRulesFrom, closedDaysLabel, dateKey, dayNames, formatSlot, hoursForDate, monthGrid, monthIndexOf, monthTitle, openingHoursLabel, parseDateKey, prettyDay, prettyDayLong, toMinutes } from "@/lib/booking";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import SignIn from "./SignIn";

type View = "dashboard" | "jobs" | "customers" | "leads" | "appointments" | "bookings" | "finances" | "waiting" | "team" | "lifecycle" | "new-job" | "new-expense" | "new-waiting" | "new-appointment" | "new-lead";
type WaitingEntry = { id: string; name: string; contact?: string; request: string; notes?: string; addedDate: string };

type NavItem = { key: View; label: string; icon: LucideIcon };

const navItems: NavItem[] = [
  { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { key: "jobs", label: "Jobs", icon: ClipboardList },
  { key: "customers", label: "Customers", icon: UsersRound },
  { key: "leads", label: "Leads", icon: UserRound },
  { key: "appointments", label: "Appointments", icon: CalendarDays },
  { key: "bookings", label: "Bookings", icon: CalendarCheck },
  { key: "finances", label: "Finances", icon: WalletCards },
  { key: "waiting", label: "Waiting List", icon: ListFilter },
  { key: "team", label: "Team", icon: UsersRound },
  { key: "lifecycle", label: "Lifecycle", icon: Sparkles },
];

const steps = ["New inquiry", "Measurements", "Quote", "In progress", "Ready", "Delivered"];

const cloneData = (): AppData => JSON.parse(JSON.stringify(seedData)) as AppData;

/**
 * Columns Postgres types strictly, which the app may hold as an empty string.
 *
 * This is only a FAST PATH, not the guarantee. saveRows retries anyway, so a
 * column missing from this list costs one wasted request rather than a lost
 * record. That is deliberate: the list used to be load-bearing, which meant a
 * new numeric column would silently reintroduce the bug.
 */
const POSTGRES_TYPED_COLUMNS = [
  "start_date", "delivery_date", "date",
  "amount_to_charge", "deposit_paid", "balance_due", "tip_received", "time_spent_minutes", "amount",
];

const nullTypedBlanks = (row: object): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...row };
  for (const key of POSTGRES_TYPED_COLUMNS) {
    if (out[key] === "") out[key] = null;
  }
  return out;
};

/** The blunt version: every empty string becomes null, whatever the column. */
const nullEveryBlank = (row: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) out[key] = value === "" ? null : value;
  return out;
};

/** Just enough of the Supabase client to save rows, so this needs no import. */
type WriteResult = { error: unknown };
type Row = Record<string, unknown>;
type TableWriter = {
  from: (table: string) => {
    insert: (rows: Row | Row[]) => PromiseLike<WriteResult>;
    upsert: (rows: Row | Row[]) => PromiseLike<WriteResult>;
    update: (row: Row) => { eq: (column: string, value: unknown) => PromiseLike<WriteResult> };
  };
};

/**
 * Saves rows, retrying in progressively more forgiving ways.
 *
 *   1. as given, which is right almost always
 *   2. with every empty string nulled. Which columns Postgres types strictly
 *      is not knowable from the client, so this is driven by the rejection
 *      rather than by a list that has to stay correct forever.
 *   3. one row at a time, because an insert is atomic: without this, a single
 *      bad record rejects the whole batch. That is how one empty delivery_date
 *      dropped all 57 jobs at once.
 */
const saveRows = async (client: TableWriter, table: string, rows: Row[], mode: "insert" | "upsert", label: string): Promise<{ saved: number; failed: number }> => {
  if (rows.length === 0) return { saved: 0, failed: 0 };
  const write = (payload: Row | Row[]) => (mode === "upsert" ? client.from(table).upsert(payload) : client.from(table).insert(payload));

  if (!(await write(rows)).error) return { saved: rows.length, failed: 0 };

  const nulled = rows.map(nullEveryBlank);
  if (!(await write(nulled)).error) return { saved: rows.length, failed: 0 };

  let saved = 0;
  let failed = 0;
  for (const row of nulled) {
    const one = await write(row);
    if (one.error) {
      failed += 1;
      console.error(`[stitchflow] could not save a ${label}:`, one.error, row);
    } else {
      saved += 1;
    }
  }
  console.log(`[stitchflow] ${table}: batch rejected, saved ${saved} of ${rows.length} individually`);
  return { saved, failed };
};

/** An update carries a whole record too, so it gets the same empty-string retry. */
const saveUpdate = async (client: TableWriter, table: string, row: Row, matchColumn: string, matchValue: unknown, label: string) => {
  const run = (payload: Row) => client.from(table).update(payload).eq(matchColumn, matchValue);
  if (!(await run(row)).error) return;
  const retry = await run(nullEveryBlank(row));
  if (retry.error) console.error(`[stitchflow] saving ${label} failed:`, retry.error);
};

/**
 * Merges records this browser still holds into what the database returned.
 *
 * The app has no delete, so a record that exists locally but not in the
 * database was lost rather than removed on purpose -- a dropped write, or a
 * migration that failed on one bad row. Putting it back turns the browser's
 * cached copy into a safety net instead of just a stale duplicate.
 *
 * Returns the merged data plus the rows that need re-uploading.
 */
const mergeLocalOnly = (remote: AppData, local: AppData) => {
  const keyToTable: [keyof AppData, string][] = [
    ["customers", "customers"], ["jobs", "jobs"], ["leads", "leads"],
    ["expenses", "expenses"], ["appointments", "appointments"], ["lifecycle", "customer_lifecycle"],
  ];
  const data: AppData = { ...remote };
  const additions: { table: string; rows: Row[] }[] = [];

  for (const [key, table] of keyToTable) {
    const known = new Set((remote[key] as { id?: string }[]).map((row) => row.id));
    const extras = (local[key] as unknown as { id?: string }[]).filter((row) => row?.id && !known.has(row.id));
    if (extras.length === 0) continue;
    (data[key] as unknown[]) = [...(remote[key] as unknown[]), ...extras];
    additions.push({ table, rows: extras as unknown as Row[] });
  }
  return { data, additions };
};

const loadStoredData = (): AppData => {
  if (typeof window === "undefined") return cloneData();
  try {
    const raw = window.localStorage.getItem("stitchflow-data");
    if (!raw) return cloneData();
    return { ...cloneData(), ...(JSON.parse(raw) as Partial<AppData>) };
  } catch {
    return cloneData();
  }
};

/**
 * Whether this browser has ever actually saved the workspace. loadStoredData
 * falls back to the demo seed records, so without this a brand new device
 * would look like it had data and would push those samples into the studio's
 * real database.
 */
const hasStoredData = (): boolean => {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem("stitchflow-data") !== null;
  } catch {
    return false;
  }
};

const loadStoredWaitingList = (): WaitingEntry[] => {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem("stitchflow-waiting-list");
    return raw ? JSON.parse(raw) as WaitingEntry[] : [];
  } catch {
    return [];
  }
};

const defaultExpenseCategories = ["Supplies", "Fabric", "Equipment", "Rent & utilities", "Marketing", "Other"];

const loadStoredCategories = (): string[] => {
  if (typeof window === "undefined") return [...defaultExpenseCategories];
  try {
    const raw = window.localStorage.getItem("stitchflow-expense-categories");
    const parsed = raw ? JSON.parse(raw) as unknown : null;
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((item) => typeof item === "string")) return parsed as string[];
    return [...defaultExpenseCategories];
  } catch {
    return [...defaultExpenseCategories];
  }
};

const numeric = (value: number | string | undefined) => Number(value || 0);

const isClosed = (status?: string) => ["paid", "delivered", "cancelled"].includes((status || "").toLowerCase());

/**
 * Whether a job belongs to a customer.
 *
 * The id is authoritative. Two customers can share a name -- the studio has two
 * Saras, in different towns -- and matching on the name as well made each one
 * show the other's job history. The name is only a fallback, for rows saved
 * before a customer id was recorded.
 */
const jobBelongsTo = (job: Job, customer: Customer) =>
  job.customer_id
    ? job.customer_id === customer.id
    : (job.customer_name || "").toLowerCase() === customer.customer_name.toLowerCase();

/** The same rule for appointments and lifecycle records, which use linked_*. */
const linkedTo = (record: { linked_id?: string; linked_name?: string }, customer: Customer) =>
  record.linked_id
    ? record.linked_id === customer.id
    : (record.linked_name || "").toLowerCase() === customer.customer_name.toLowerCase();

/**
 * The next job number, taken from the highest number already in use.
 *
 * This used to be `JOB-${jobs.length + 1}`, which counts rows rather than
 * numbers. The studio's earlier jobs are not numbered 1..n, so the first job
 * added through the app landed on JOB-0058, which already existed -- and every
 * job after it collided the same way. Reading the highest number instead
 * cannot repeat one.
 */
const nextJobNumber = (jobs: Job[]) => {
  const highest = jobs.reduce((max, job) => {
    const digits = Number(String(job.job_id || "").replace(/\D/g, ""));
    return Number.isFinite(digits) ? Math.max(max, digits) : max;
  }, 0);
  return `JOB-${String(highest + 1).padStart(4, "0")}`;
};

const isDueSoon = (job: Job) => {
  if (!job.delivery_date || isClosed(job.status)) return false;
  const due = new Date(`${job.delivery_date}T12:00:00`).getTime();
  const now = new Date();
  const today = new Date(`${now.toISOString().slice(0, 10)}T12:00:00`).getTime();
  return due >= today && due <= today + 3 * 24 * 60 * 60 * 1000;
};

const dueLabel = (value?: string) => {
  if (!value) return "No due date";
  const now = new Date();
  const today = new Date(`${now.toISOString().slice(0, 10)}T12:00:00`).getTime();
  const due = new Date(`${value}T12:00:00`).getTime();
  const days = Math.round((due - today) / (24 * 60 * 60 * 1000));
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  return `Due ${shortDate(value)}`;
};

const statusLabel = (status?: string) => (status || "").toLowerCase() === "new order" ? "New Job" : status || "New Job";

const datePlusOne = (value: string) => {
  const date = new Date(`${value}T12:00:00`);
  date.setDate(date.getDate() + 1);
  return date.toISOString().slice(0, 10).replaceAll("-", "");
};

const googleCalendarUrl = (appointment: Appointment) => {
  const params = new URLSearchParams({ action: "TEMPLATE", text: appointment.title || "Studio appointment", details: appointment.notes || "", location: "Rachel's Seamstress Studio" });
  if (appointment.date) {
    if (appointment.time) {
      const start = new Date(`${appointment.date}T${appointment.time}:00`);
      const end = new Date(start.getTime() + 60 * 60 * 1000);
      const format = (value: Date) => `${value.getFullYear()}${String(value.getMonth() + 1).padStart(2, "0")}${String(value.getDate()).padStart(2, "0")}T${String(value.getHours()).padStart(2, "0")}${String(value.getMinutes()).padStart(2, "0")}00`;
      params.set("dates", `${format(start)}/${format(end)}`);
    } else {
      params.set("dates", `${appointment.date.replaceAll("-", "")}/${datePlusOne(appointment.date)}`);
    }
  }
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
};

const escapeHtml = (value: string) => value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] || character);

type QuoteDraft = { businessName: string; description: string; price: string; validUntil: string; notes: string };
type InvoiceDraft = { businessName: string; clientName: string; phone: string; description: string; dueDate: string; amount: string; deposit: string; balance: string; paymentMethod: string; notes: string };

const openInvoice = (job: Job, customer: Customer | undefined, draft: InvoiceDraft) => {
  const popup = window.open("", "_blank");
  if (!popup) return;
  const invoiceNumber = job.job_id || job.id;
  popup.document.write(`<!doctype html><html><head><title>Invoice ${escapeHtml(invoiceNumber)}</title><style>body{font-family:Arial,sans-serif;color:#2f2b29;max-width:760px;margin:48px auto;padding:0 24px}header{display:flex;justify-content:space-between;border-bottom:2px solid #c98781;padding-bottom:20px;margin-bottom:30px}h1{margin:0;font-size:28px}h2{margin:0 0 6px;font-size:18px}p{color:#6f6963;line-height:1.5}.meta{color:#6f6963;font-size:13px}.box{border:1px solid #e8e1d7;border-radius:10px;padding:18px;margin:18px 0}.summary{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.summary div{border:1px solid #e8e1d7;border-radius:8px;padding:12px}.summary strong{display:block;margin-top:6px}.total{display:flex;justify-content:space-between;font-size:20px;font-weight:700;border-top:1px solid #e8e1d7;padding-top:16px;margin-top:24px}@media print{body{margin:0}}</style></head><body><header><div><h1>${escapeHtml(draft.businessName)}</h1><div class="meta">Rachel's Seamstress Studio</div></div><div style="text-align:right"><strong>INVOICE</strong><div class="meta">${escapeHtml(invoiceNumber)}</div></div></header><div class="box"><h2>Bill to</h2><div>${escapeHtml(draft.clientName)}</div><div class="meta">${escapeHtml(draft.phone)}</div><div class="meta">${escapeHtml(customer?.email || job.email || "")}</div><div class="meta">${escapeHtml(customer?.address || "")}</div></div><div class="box"><h2>Job details</h2><p>${escapeHtml(draft.description || "Alteration services")}</p><div class="meta">${draft.dueDate ? `Due ${escapeHtml(fullDate(draft.dueDate))}` : ""}</div></div><div class="summary"><div>Amount<strong>${money(draft.amount)}</strong></div><div>Deposit<strong>${money(draft.deposit)}</strong></div><div>Payment method<strong>${escapeHtml(draft.paymentMethod)}</strong></div></div><div class="total"><span>Balance due</span><span>${money(draft.balance)}</span></div>${draft.notes ? `<p>${escapeHtml(draft.notes)}</p>` : ""}<p style="margin-top:32px">Thank you for your business!</p><script>window.onload=function(){window.print()}</script></body></html>`);
  popup.document.close();
};

const openQuote = (job: Job, customer: Customer | undefined, draft: QuoteDraft) => {
  const popup = window.open("", "_blank");
  if (!popup) return;
  const quoteNumber = job.job_id || job.id;
  popup.document.write(`<!doctype html><html><head><title>Quote ${escapeHtml(quoteNumber)}</title><style>body{font-family:Arial,sans-serif;color:#2f2b29;max-width:760px;margin:48px auto;padding:0 24px}header{display:flex;justify-content:space-between;border-bottom:2px solid #c98781;padding-bottom:20px;margin-bottom:30px}h1{margin:0;font-size:28px}h2{margin:0 0 6px;font-size:18px}p{color:#6f6963;line-height:1.5}.meta{color:#6f6963;font-size:13px}.box{border:1px solid #e8e1d7;border-radius:10px;padding:18px;margin:18px 0}.total{display:flex;justify-content:space-between;font-size:20px;font-weight:700;border-top:1px solid #e8e1d7;padding-top:16px;margin-top:24px}@media print{body{margin:0}}</style></head><body><header><div><h1>${escapeHtml(draft.businessName)}</h1><div class="meta">Quote ${escapeHtml(quoteNumber)}</div></div><div style="text-align:right"><strong>QUOTE</strong><div class="meta">Valid until ${draft.validUntil ? escapeHtml(fullDate(draft.validUntil)) : "—"}</div></div></header><div class="box"><h2>Prepared for</h2><div>${escapeHtml(customer?.customer_name || job.customer_name)}</div><div class="meta">${escapeHtml(customer?.email || job.email || "")}</div></div><div class="box"><h2>Description of work</h2><p>${escapeHtml(draft.description || "Alteration services")}</p></div><div class="total"><span>Estimated price</span><span>${money(draft.price)}</span></div>${draft.notes ? `<p>${escapeHtml(draft.notes)}</p>` : ""}<p style="margin-top:32px">Thank you for considering our studio.</p><script>window.onload=function(){window.print()}</script></body></html>`);
  popup.document.close();
};

function SectionHeading({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  return <div className="section-heading"><h2>{title}</h2>{action && <button onClick={onAction}>{action} <ChevronRight size={14} /></button>}</div>;
}

function StatusBadge({ status }: { status?: string }) {
  return <span className={`badge ${statusTone(status)}`}>{statusLabel(status)}</span>;
}

function SearchBox({ value, onChange, placeholder = "Search...", onSubmit }: { value: string; onChange: (value: string) => void; placeholder?: string; onSubmit?: () => void }) {
  return <div className="search-box"><button aria-label="Search" onClick={onSubmit}><Search size={16} /></button><input value={value} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => event.key === "Enter" && onSubmit?.()} placeholder={placeholder} /></div>;
}

function DashboardView({ data, go, onSelectJob }: { data: AppData; go: (view: View) => void; onSelectJob: (job: Job) => void }) {
  const activeJobs = data.jobs.filter((job) => !isClosed(job.status));
  const dueSoon = activeJobs.filter(isDueSoon).sort((a, b) => String(a.delivery_date).localeCompare(String(b.delivery_date)));
  const outstanding = activeJobs.reduce((sum, job) => sum + numeric(job.balance_due), 0);
  const revenue = data.jobs.filter((job) => (job.status || "").toLowerCase() === "paid").reduce((sum, job) => sum + numeric(job.amount_to_charge), 0);
  const ready = data.jobs.filter((job) => (job.status || "").toLowerCase() === "ready for pickup");
  const displayedActive = activeJobs.slice(0, 3);
  const today = fullDate(new Date().toISOString().slice(0, 10));

  return <>
    <div className="page-heading"><div><div className="eyebrow"><Scissors size={14} style={{ verticalAlign: "-2px", marginRight: 5 }} />Studio Manager</div><h1>Good morning, Rachel</h1><p>{today}</p></div><div className="page-heading-actions"><button className="button primary" onClick={() => go("new-job")}><Plus size={15} /> Add Job</button></div></div>

    {dueSoon.length > 0 && <div className="notice"><div className="notice-title"><AlarmClock size={17} /> {dueSoon.length} job{dueSoon.length === 1 ? "" : "s"} due within 3 days</div><div className="notice-row"><span>{dueSoon[0].customer_name}</span><span>{dueLabel(dueSoon[0].delivery_date)}</span></div></div>}

    <div className="metric-grid">
      <div className="metric-card"><div className="metric-icon rose"><CircleDollarSign size={15} /></div><div className="metric-label">Outstanding</div><div className="metric-value">{money(outstanding)}</div><div className="metric-note">Balance owed</div></div>
      <div className="metric-card"><div className="metric-icon green"><CircleDollarSign size={15} /></div><div className="metric-label">Total Revenue</div><div className="metric-value">{money(revenue)}</div><div className="metric-note">Paid jobs, all time</div></div>
      <div className="metric-card"><div className="metric-icon amber"><Clock3 size={15} /></div><div className="metric-label">Active Jobs</div><div className="metric-value">{activeJobs.length}</div><div className="metric-note">In progress / new</div></div>
      <div className="metric-card"><div className="metric-icon mint"><CheckCircle2 size={15} /></div><div className="metric-label">Ready for Pickup</div><div className="metric-value">{ready.length}</div><div className="metric-note">Waiting on customer</div></div>
    </div>

    <section className="section"><SectionHeading title="Active Jobs" action="View all" onAction={() => go("jobs")} /><div className="stack">{displayedActive.length === 0 ? <div className="empty">No active jobs right now 🎉</div> : displayedActive.map((job) => <JobRow key={job.id} job={job} onSelect={onSelectJob} />)}</div></section>
    <section className="section"><SectionHeading title="Due Soon" /><div className="stack">{dueSoon.length === 0 ? <div className="empty">Nothing due in the next three days.</div> : dueSoon.slice(0, 3).map((job) => <JobRow key={`due-${job.id}`} job={job} compact showAmount onSelect={onSelectJob} />)}</div></section>
  </>;
}

function JobRow({ job, compact = false, showAmount = false, onToast, onSelect, onEdit, onSendQuote, onExportInvoice }: { job: Job; compact?: boolean; showAmount?: boolean; onToast?: (message: string) => void; onSelect?: (job: Job) => void; onEdit?: (job: Job) => void; onSendQuote?: (job: Job) => void; onExportInvoice?: (job: Job) => void }) {
  const select = () => onSelect?.(job);
  return <div className={`job-row ${onSelect ? "clickable" : ""}`} role={onSelect ? "button" : undefined} tabIndex={onSelect ? 0 : undefined} onClick={select} onKeyDown={(event) => { if (onSelect && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); select(); } }}><div className="avatar">{initials(job.customer_name)}</div><div className="job-row-main"><div className="row-title">{job.customer_name} <span className="muted">{job.job_id ? `#${job.job_id}` : ""}</span></div><div className="row-description">{job.job_details || "No job details added yet."}</div>{!compact && <div className="row-meta">{job.delivery_date ? shortDate(job.delivery_date) : "No due date"}</div>}</div><div className="row-right">{showAmount && <span className="row-meta">{money(job.amount_to_charge)}</span>}<StatusBadge status={job.status} /><span className="desktop-job-actions">{onEdit && <button className="button small" aria-label={`Edit ${job.job_id || "job"}`} onClick={(event) => { event.stopPropagation(); onEdit(job); }}><Pencil size={13} /> Edit</button>}{onSendQuote && <button className="button small" onClick={(event) => { event.stopPropagation(); onSendQuote(job); }}>Send Quote</button>}{onExportInvoice && <button className="button small" onClick={(event) => { event.stopPropagation(); onExportInvoice(job); }}><FileDown size={13} /> Export Invoice</button>}{onToast && !onSendQuote && !onExportInvoice && <><button className="button small" onClick={(event) => { event.stopPropagation(); onToast("Quote action ready to connect to your email provider."); }}>Send Quote</button><button className="button small" onClick={(event) => { event.stopPropagation(); onToast("Invoice export queued."); }}><FileDown size={13} /> Export Invoice</button></>}</span></div>{(onSendQuote || onExportInvoice || onEdit) && <div className="mobile-job-actions">{onSendQuote && <button className="button small" onClick={(event) => { event.stopPropagation(); onSendQuote(job); }}>Send Quote</button>}{onExportInvoice && <button className="button small" onClick={(event) => { event.stopPropagation(); onExportInvoice(job); }}><FileDown size={13} /> Export Invoice</button>}{onEdit && <button className="button small" onClick={(event) => { event.stopPropagation(); onEdit(job); }}><Pencil size={13} /> Edit</button>}</div>}</div>;
}

function QuoteModal({ job, customer, onClose }: { job: Job; customer?: Customer; onClose: () => void }) {
  const [draft, setDraft] = useState<QuoteDraft>({ businessName: "Rachel's Studio", description: job.job_details || "", price: String(job.amount_to_charge || ""), validUntil: "", notes: "" });
  const update = (key: keyof QuoteDraft, value: string) => setDraft((current) => ({ ...current, [key]: value }));
  const download = (event: FormEvent) => { event.preventDefault(); openQuote(job, customer, draft); onClose(); };
  return <div className="modal-backdrop document-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><form className="document-modal" onSubmit={download} role="dialog" aria-modal="true" aria-label="Send quote"><div className="modal-heading"><h2>Send Quote</h2><button type="button" className="icon-button" aria-label="Close quote" onClick={onClose}><X size={18} /></button></div><div className="document-modal-body"><div className="field"><label htmlFor="quote-business">Business Name</label><input id="quote-business" value={draft.businessName} onChange={(event) => update("businessName", event.target.value)} /></div><div className="field"><label htmlFor="quote-description">Description of Work</label><textarea id="quote-description" value={draft.description} onChange={(event) => update("description", event.target.value)} placeholder="Describe the work..." required /></div><div className="modal-two"><div className="field"><label htmlFor="quote-price">Estimated Price ($)</label><input id="quote-price" type="number" min="0" step="0.01" value={draft.price} onChange={(event) => update("price", event.target.value)} required /></div><div className="field"><label htmlFor="quote-valid">Quote Valid Until</label><input id="quote-valid" type="date" value={draft.validUntil} onChange={(event) => update("validUntil", event.target.value)} /></div></div><div className="field"><label htmlFor="quote-notes">Additional Notes</label><textarea id="quote-notes" value={draft.notes} onChange={(event) => update("notes", event.target.value)} placeholder="Any terms, conditions, or extra info..." /></div></div><div className="document-modal-footer"><button type="button" className="button" onClick={onClose}>Cancel</button><button type="submit" className="button primary">Download Quote PDF</button></div></form></div>;
}

function InvoiceModal({ job, customer, onClose }: { job: Job; customer?: Customer; onClose: () => void }) {
  const [draft, setDraft] = useState<InvoiceDraft>({ businessName: "Rachel's Studio", clientName: customer?.customer_name || job.customer_name, phone: customer?.phone_number || job.phone_number || "", description: job.job_details || "", dueDate: job.delivery_date || "", amount: String(job.amount_to_charge || ""), deposit: String(job.deposit_paid || ""), balance: String(job.balance_due || ""), paymentMethod: job.payment_method || "Cash", notes: job.notes || "" });
  const update = (key: keyof InvoiceDraft, value: string) => setDraft((current) => ({ ...current, [key]: value }));
  const download = (event: FormEvent) => { event.preventDefault(); openInvoice(job, customer, draft); onClose(); };
  return <div className="modal-backdrop document-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><form className="document-modal invoice-modal" onSubmit={download} role="dialog" aria-modal="true" aria-label="Export invoice"><div className="modal-heading"><h2>Export Invoice</h2><button type="button" className="icon-button" aria-label="Close invoice" onClick={onClose}><X size={18} /></button></div><div className="document-modal-body"><div className="field"><label htmlFor="invoice-business">Business Name</label><input id="invoice-business" value={draft.businessName} onChange={(event) => update("businessName", event.target.value)} /></div><div className="field"><label htmlFor="invoice-client">Client Name</label><input id="invoice-client" value={draft.clientName} onChange={(event) => update("clientName", event.target.value)} required /></div><div className="field"><label htmlFor="invoice-phone">Phone</label><input id="invoice-phone" value={draft.phone} onChange={(event) => update("phone", event.target.value)} /></div><div className="field"><label htmlFor="invoice-description">Description of Work</label><textarea id="invoice-description" value={draft.description} onChange={(event) => update("description", event.target.value)} required /></div><div className="field"><label htmlFor="invoice-due">Due Date</label><input id="invoice-due" type="date" value={draft.dueDate} onChange={(event) => update("dueDate", event.target.value)} /></div><div className="modal-three"><div className="field"><label htmlFor="invoice-amount">Amount ($)</label><input id="invoice-amount" type="number" min="0" step="0.01" value={draft.amount} onChange={(event) => update("amount", event.target.value)} /></div><div className="field"><label htmlFor="invoice-deposit">Deposit ($)</label><input id="invoice-deposit" type="number" min="0" step="0.01" value={draft.deposit} onChange={(event) => update("deposit", event.target.value)} /></div><div className="field"><label htmlFor="invoice-balance">Balance ($)</label><input id="invoice-balance" type="number" min="0" step="0.01" value={draft.balance} onChange={(event) => update("balance", event.target.value)} /></div></div><div className="field"><label htmlFor="invoice-payment">Payment Method</label><select id="invoice-payment" value={draft.paymentMethod} onChange={(event) => update("paymentMethod", event.target.value)}><option>Cash</option><option>Card</option><option>Check</option><option>Venmo</option><option>Other</option></select></div><div className="field"><label htmlFor="invoice-notes">Notes</label><textarea id="invoice-notes" value={draft.notes} onChange={(event) => update("notes", event.target.value)} placeholder="Add any extra invoice notes..." /></div></div><div className="document-modal-footer"><button type="button" className="button" onClick={onClose}>Cancel</button><button type="submit" className="button primary">Download PDF</button></div></form></div>;
}

function EditModalShell({ title, ariaLabel, onClose, onSubmit, children, submitLabel = "Save changes" }: { title: string; ariaLabel: string; onClose: () => void; onSubmit: (event: FormEvent) => void; children: ReactNode; submitLabel?: string }) {
  return <div className="modal-backdrop document-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><form className="document-modal edit-record-modal" onSubmit={onSubmit} role="dialog" aria-modal="true" aria-label={ariaLabel}><div className="modal-heading"><h2>{title}</h2><button type="button" className="icon-button" aria-label={`Close ${ariaLabel}`} onClick={onClose}><X size={18} /></button></div><div className="document-modal-body">{children}</div><div className="document-modal-footer"><button type="button" className="button" onClick={onClose}>Cancel</button><button type="submit" className="button primary"><Pencil size={14} /> {submitLabel}</button></div></form></div>;
}

function EditCustomerModal({ customer, onClose, onSave }: { customer: Customer; onClose: () => void; onSave: (customer: Customer) => void }) {
  const [draft, setDraft] = useState<Customer>({ ...customer });
  const update = (key: keyof Customer, value: string) => setDraft((current) => ({ ...current, [key]: value }));
  const submit = (event: FormEvent) => { event.preventDefault(); onSave(draft); };
  return <EditModalShell title="Edit Customer" ariaLabel="edit customer" onClose={onClose} onSubmit={submit}><div className="modal-two"><div className="field"><label htmlFor="edit-customer-name">Customer name</label><input id="edit-customer-name" value={draft.customer_name} onChange={(event) => update("customer_name", event.target.value)} required /></div><div className="field"><label htmlFor="edit-customer-phone">Phone</label><input id="edit-customer-phone" value={draft.phone_number || ""} onChange={(event) => update("phone_number", event.target.value)} /></div></div><div className="modal-two"><div className="field"><label htmlFor="edit-customer-email">Email</label><input id="edit-customer-email" type="email" value={draft.email || ""} onChange={(event) => update("email", event.target.value)} /></div><div className="field"><label htmlFor="edit-customer-source">Source</label><select id="edit-customer-source" value={draft.source || "Other"} onChange={(event) => update("source", event.target.value)}><option>Walk-in</option><option>Phone</option><option>Facebook</option><option>Referral</option><option>Other</option></select></div></div><div className="field"><label htmlFor="edit-customer-address">Address</label><input id="edit-customer-address" value={draft.address || ""} onChange={(event) => update("address", event.target.value)} /></div><div className="field"><label htmlFor="edit-customer-referred">Referred by</label><input id="edit-customer-referred" value={draft.referred_by || ""} onChange={(event) => update("referred_by", event.target.value)} /></div><div className="field"><label htmlFor="edit-customer-notes">Notes</label><textarea id="edit-customer-notes" value={draft.notes || ""} onChange={(event) => update("notes", event.target.value)} placeholder="Add customer notes..." /></div></EditModalShell>;
}

function NewCustomerModal({ onClose, onSave }: { onClose: () => void; onSave: (customer: Customer) => void }) {
  const [draft, setDraft] = useState<Customer>({ id: "", customer_name: "", source: "Walk-in" });
  const update = (key: keyof Customer, value: string) => setDraft((current) => ({ ...current, [key]: value }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave({ ...draft, id: `local-customer-${Date.now()}`, created_date: new Date().toISOString() });
  };
  return <EditModalShell title="Add Customer" ariaLabel="add customer" onClose={onClose} onSubmit={submit} submitLabel="Add customer"><div className="modal-two"><div className="field"><label htmlFor="new-customer-name">Customer name</label><input id="new-customer-name" value={draft.customer_name} onChange={(event) => update("customer_name", event.target.value)} placeholder="Full name" required autoFocus /></div><div className="field"><label htmlFor="new-customer-phone">Phone</label><input id="new-customer-phone" value={draft.phone_number || ""} onChange={(event) => update("phone_number", event.target.value)} placeholder="(555) 123-4567" /></div></div><div className="modal-two"><div className="field"><label htmlFor="new-customer-email">Email</label><input id="new-customer-email" type="email" value={draft.email || ""} onChange={(event) => update("email", event.target.value)} placeholder="name@example.com" /></div><div className="field"><label htmlFor="new-customer-source">Source</label><select id="new-customer-source" value={draft.source || "Walk-in"} onChange={(event) => update("source", event.target.value)}><option>Walk-in</option><option>Phone</option><option>Facebook</option><option>Referral</option><option>Other</option></select></div></div><div className="field"><label htmlFor="new-customer-address">Address</label><input id="new-customer-address" value={draft.address || ""} onChange={(event) => update("address", event.target.value)} placeholder="Street, town, ZIP" /></div><div className="field"><label htmlFor="new-customer-referred">Referred by</label><input id="new-customer-referred" value={draft.referred_by || ""} onChange={(event) => update("referred_by", event.target.value)} placeholder="Optional" /></div><div className="field"><label htmlFor="new-customer-notes">Notes</label><textarea id="new-customer-notes" value={draft.notes || ""} onChange={(event) => update("notes", event.target.value)} placeholder="Add customer notes..." /></div></EditModalShell>;
}

function EditJobModal({ job, customers, onClose, onSave }: { job: Job; customers: Customer[]; onClose: () => void; onSave: (job: Job) => void }) {
  const [draft, setDraft] = useState<Job>({ ...job });
  const update = (key: keyof Job, value: string | number) => setDraft((current) => ({ ...current, [key]: value }));
  const updateCustomer = (value: string) => {
    const customer = customers.find((item) => item.customer_name === value);
    setDraft((current) => ({ ...current, customer_name: value, customer_id: customer?.id || current.customer_id, phone_number: customer?.phone_number || current.phone_number, email: customer?.email || current.email }));
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    // A job cannot be Paid and still owe a balance. Marking it paid clears the
    // balance, otherwise the page reads "Paid" and "Balance due" at the same
    // time -- which is how six of them ended up that way.
    const settled = (draft.status || "").trim().toLowerCase() === "paid";
    onSave(settled && numeric(draft.balance_due) !== 0 ? { ...draft, balance_due: 0 } : draft);
  };
  return <EditModalShell title="Edit Job" ariaLabel="edit job" onClose={onClose} onSubmit={submit}><div className="modal-two"><div className="field"><label htmlFor="edit-job-customer">Customer</label><input id="edit-job-customer" list="edit-job-customers" value={draft.customer_name} onChange={(event) => updateCustomer(event.target.value)} required /><datalist id="edit-job-customers">{customers.map((customer) => <option key={customer.id} value={customer.customer_name}>{customer.phone_number || customer.email || ""}</option>)}</datalist></div><div className="field"><label htmlFor="edit-job-status">Status</label><select id="edit-job-status" value={statusLabel(draft.status)} onChange={(event) => update("status", event.target.value)}><option>New Job</option><option>In Progress</option><option>Ready for Pickup</option><option>Delivered</option><option>Paid</option><option>Cancelled</option></select></div></div><div className="field"><label htmlFor="edit-job-details">Job details</label><textarea id="edit-job-details" value={draft.job_details || ""} onChange={(event) => update("job_details", event.target.value)} placeholder="Describe the alterations or project..." required /></div><div className="modal-four"><div className="field"><label htmlFor="edit-job-amount">Amount ($)</label><input id="edit-job-amount" type="number" min="0" step="0.01" value={draft.amount_to_charge ?? ""} onChange={(event) => update("amount_to_charge", event.target.value)} /></div><div className="field"><label htmlFor="edit-job-deposit">Deposit ($)</label><input id="edit-job-deposit" type="number" min="0" step="0.01" value={draft.deposit_paid ?? ""} onChange={(event) => update("deposit_paid", event.target.value)} /></div><div className="field"><label htmlFor="edit-job-balance">Balance ($)</label><input id="edit-job-balance" type="number" min="0" step="0.01" value={draft.balance_due ?? ""} onChange={(event) => update("balance_due", event.target.value)} /></div><div className="field"><label htmlFor="edit-job-tip">Tip ($)</label><input id="edit-job-tip" type="number" min="0" step="0.01" value={draft.tip_received ?? ""} onChange={(event) => update("tip_received", event.target.value)} /></div></div><div className="modal-two"><div className="field"><label htmlFor="edit-job-delivery">Delivery date</label><input id="edit-job-delivery" type="date" value={draft.delivery_date || ""} onChange={(event) => update("delivery_date", event.target.value)} /></div><div className="field"><label htmlFor="edit-job-payment">Payment method</label><select id="edit-job-payment" value={draft.payment_method || "Cash"} onChange={(event) => update("payment_method", event.target.value)}><option>Cash</option><option>Card</option><option>Check</option><option>Venmo</option><option>Other</option></select></div></div><div className="field"><label htmlFor="edit-job-measurements">Measurement notes</label><textarea id="edit-job-measurements" value={draft.measurement_notes || ""} onChange={(event) => update("measurement_notes", event.target.value)} placeholder="Add fitting measurements or preferences..." /></div><div className="field"><label htmlFor="edit-job-notes">Notes</label><textarea id="edit-job-notes" value={draft.notes || ""} onChange={(event) => update("notes", event.target.value)} placeholder="Add job notes..." /></div></EditModalShell>;
}

function EditLeadModal({ lead, onClose, onSave }: { lead: Lead; onClose: () => void; onSave: (lead: Lead) => void }) {
  const [draft, setDraft] = useState<Lead>({ ...lead });
  const update = (key: keyof Lead, value: string) => setDraft((current) => ({ ...current, [key]: value }));
  const submit = (event: FormEvent) => { event.preventDefault(); onSave(draft); };
  return <EditModalShell title="Edit Lead" ariaLabel="edit lead" onClose={onClose} onSubmit={submit}><div className="modal-two"><div className="field"><label htmlFor="edit-lead-name">Name</label><input id="edit-lead-name" value={draft.name} onChange={(event) => update("name", event.target.value)} required /></div><div className="field"><label htmlFor="edit-lead-status">Status</label><select id="edit-lead-status" value={draft.status || "New"} onChange={(event) => update("status", event.target.value)}><option>New</option><option>Contacted</option><option>Qualified</option><option>Converted</option><option>Lost</option></select></div></div><div className="modal-two"><div className="field"><label htmlFor="edit-lead-phone">Phone</label><input id="edit-lead-phone" value={draft.phone_number || ""} onChange={(event) => update("phone_number", event.target.value)} /></div><div className="field"><label htmlFor="edit-lead-email">Email</label><input id="edit-lead-email" type="email" value={draft.email || ""} onChange={(event) => update("email", event.target.value)} /></div></div><div className="modal-two"><div className="field"><label htmlFor="edit-lead-location">Location</label><input id="edit-lead-location" value={draft.location || ""} onChange={(event) => update("location", event.target.value)} /></div><div className="field"><label htmlFor="edit-lead-source">Source</label><select id="edit-lead-source" value={draft.source || "Other"} onChange={(event) => update("source", event.target.value)}><option>Phone</option><option>Facebook</option><option>Referral</option><option>Walk-in</option><option>Other</option></select></div></div><div className="field"><label htmlFor="edit-lead-interest">Interested in</label><textarea id="edit-lead-interest" value={draft.interested_in || ""} onChange={(event) => update("interested_in", event.target.value)} placeholder="Describe what they are looking for..." /></div><div className="field"><label htmlFor="edit-lead-notes">Notes</label><textarea id="edit-lead-notes" value={draft.notes || ""} onChange={(event) => update("notes", event.target.value)} placeholder="Add follow-up notes..." /></div></EditModalShell>;
}

function ManageCategoriesModal({ categories, expenses, onChange, onClose }: { categories: string[]; expenses: Expense[]; onChange: (next: string[]) => void; onClose: () => void }) {
  const [draft, setDraft] = useState<string[]>(categories);
  const [newName, setNewName] = useState("");
  const usage = (name: string) => {
    const rows = expenses.filter((expense) => (expense.category || "Other") === name);
    return { count: rows.length, total: rows.reduce((sum, expense) => sum + numeric(expense.amount), 0) };
  };
  const add = () => {
    const name = newName.trim();
    if (!name) return;
    setDraft((current) => current.some((item) => item.toLowerCase() === name.toLowerCase()) ? current : [...current, name]);
    setNewName("");
  };
  const submit = (event: FormEvent) => { event.preventDefault(); onChange(draft); onClose(); };
  return <EditModalShell title="Expense Categories" ariaLabel="manage expense categories" onClose={onClose} onSubmit={submit} submitLabel="Save categories">
    <div className="guide-list">{draft.map((name) => {
      const stats = usage(name);
      return <div className="category-row" key={name}>
        <div className="category-row-main">
          <div className="row-title">{name}</div>
          <div className="row-meta">{stats.count === 0 ? "Not used yet" : `${stats.count} expense${stats.count === 1 ? "" : "s"} · ${money(stats.total)}`}</div>
        </div>
        <button type="button" className="button small" disabled={draft.length <= 1} onClick={() => setDraft((current) => current.filter((item) => item !== name))} aria-label={`Remove ${name}`}><Trash2 size={13} /> Remove</button>
      </div>;
    })}</div>
    <div className="field">
      <label htmlFor="new-category">Add a category</label>
      <div className="category-add">
        <input id="new-category" value={newName} onChange={(event) => setNewName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); add(); } }} placeholder="e.g. Dry cleaning" />
        <button type="button" className="button" onClick={add}><Plus size={14} /> Add</button>
      </div>
    </div>
  </EditModalShell>;
}

function EditAppointmentModal({ appointment, customers, onClose, onSave }: { appointment: Appointment; customers: Customer[]; onClose: () => void; onSave: (appointment: Appointment) => void }) {
  const [draft, setDraft] = useState<Appointment>({ ...appointment });
  const update = (key: keyof Appointment, value: string) => setDraft((current) => ({ ...current, [key]: value }));
  const updateCustomer = (value: string) => { const customer = customers.find((item) => item.customer_name === value); setDraft((current) => ({ ...current, linked_name: value, linked_id: customer?.id || current.linked_id, linked_type: customer ? "Customer" : current.linked_type })); };
  const submit = (event: FormEvent) => { event.preventDefault(); onSave(draft); };
  return <EditModalShell title="Edit Appointment" ariaLabel="edit appointment" onClose={onClose} onSubmit={submit}><div className="field"><label htmlFor="edit-appointment-customer">Customer</label><input id="edit-appointment-customer" list="edit-appointment-customers" value={draft.linked_name || ""} onChange={(event) => updateCustomer(event.target.value)} placeholder="Search customers..." /><datalist id="edit-appointment-customers">{customers.map((customer) => <option key={customer.id} value={customer.customer_name}>{customer.phone_number || customer.email || ""}</option>)}</datalist></div><div className="field"><label htmlFor="edit-appointment-title">Appointment type</label><input id="edit-appointment-title" value={draft.title || ""} onChange={(event) => update("title", event.target.value)} required /></div><div className="modal-three"><div className="field"><label htmlFor="edit-appointment-date">Date</label><input id="edit-appointment-date" type="date" value={draft.date || ""} onChange={(event) => update("date", event.target.value)} required /></div><div className="field"><label htmlFor="edit-appointment-time">Time</label><input id="edit-appointment-time" type="time" value={draft.time || ""} onChange={(event) => update("time", event.target.value)} /></div><div className="field"><label htmlFor="edit-appointment-status">Status</label><select id="edit-appointment-status" value={draft.status || "Scheduled"} onChange={(event) => update("status", event.target.value)}><option>Scheduled</option><option>Completed</option><option>Cancelled</option></select></div></div><div className="field"><label htmlFor="edit-appointment-notes">Notes</label><textarea id="edit-appointment-notes" value={draft.notes || ""} onChange={(event) => update("notes", event.target.value)} placeholder="Add appointment details..." /></div></EditModalShell>;
}

function EditExpenseModal({ expense, categories, onClose, onSave }: { expense: Expense; categories: string[]; onClose: () => void; onSave: (expense: Expense) => void }) {
  const [draft, setDraft] = useState<Expense>({ ...expense });
  const update = (key: keyof Expense, value: string | number) => setDraft((current) => ({ ...current, [key]: value }));
  const submit = (event: FormEvent) => { event.preventDefault(); onSave(draft); };
  return <EditModalShell title="Edit Expense" ariaLabel="edit expense" onClose={onClose} onSubmit={submit}><div className="field"><label htmlFor="edit-expense-note">Description</label><input id="edit-expense-note" value={draft.note || ""} onChange={(event) => update("note", event.target.value)} required /></div><div className="modal-two"><div className="field"><label htmlFor="edit-expense-amount">Amount</label><input id="edit-expense-amount" type="number" min="0.01" step="0.01" value={draft.amount ?? ""} onChange={(event) => update("amount", event.target.value)} required /></div><div className="field"><label htmlFor="edit-expense-date">Date</label><input id="edit-expense-date" type="date" value={draft.date || ""} onChange={(event) => update("date", event.target.value)} required /></div></div><div className="modal-two"><div className="field"><label htmlFor="edit-expense-category">Category</label><select id="edit-expense-category" value={draft.category || "Other"} onChange={(event) => update("category", event.target.value)}>{Array.from(new Set([...categories, draft.category || "Other"])).map((name) => <option key={name}>{name}</option>)}</select></div><div className="field"><label htmlFor="edit-expense-job">Job ID</label><input id="edit-expense-job" value={draft.job_id || ""} onChange={(event) => update("job_id", event.target.value)} placeholder="Optional job ID" /></div></div></EditModalShell>;
}

function EditWaitingModal({ entry, customers, onClose, onSave }: { entry: WaitingEntry; customers: Customer[]; onClose: () => void; onSave: (entry: WaitingEntry) => void }) {
  const [draft, setDraft] = useState<WaitingEntry>({ ...entry });
  const update = (key: keyof WaitingEntry, value: string) => setDraft((current) => ({ ...current, [key]: value }));
  const submit = (event: FormEvent) => { event.preventDefault(); onSave(draft); };
  return <EditModalShell title="Edit Waiting List Entry" ariaLabel="edit waiting list entry" onClose={onClose} onSubmit={submit}><div className="modal-two"><div className="field"><label htmlFor="edit-waiting-name">Customer name</label><input id="edit-waiting-name" list="edit-waiting-customers" value={draft.name} onChange={(event) => update("name", event.target.value)} required /><datalist id="edit-waiting-customers">{customers.map((customer) => <option key={customer.id} value={customer.customer_name}>{customer.phone_number || customer.email || ""}</option>)}</datalist></div><div className="field"><label htmlFor="edit-waiting-contact">Phone or email</label><input id="edit-waiting-contact" value={draft.contact || ""} onChange={(event) => update("contact", event.target.value)} /></div></div><div className="field"><label htmlFor="edit-waiting-request">What are they waiting for?</label><input id="edit-waiting-request" value={draft.request} onChange={(event) => update("request", event.target.value)} required /></div><div className="field"><label htmlFor="edit-waiting-notes">Notes</label><textarea id="edit-waiting-notes" value={draft.notes || ""} onChange={(event) => update("notes", event.target.value)} placeholder="Add any follow-up context..." /></div></EditModalShell>;
}

function EditLifecycleModal({ record, onClose, onSave }: { record: Lifecycle; onClose: () => void; onSave: (record: Lifecycle) => void }) {
  const [completed, setCompleted] = useState<number[]>(record.completed_steps || []);
  const submit = (event: FormEvent) => { event.preventDefault(); onSave({ ...record, completed_steps: completed }); };
  const toggle = (index: number) => setCompleted((current) => current.includes(index) ? current.filter((step) => step !== index) : [...current, index].sort((a, b) => a - b));
  return <EditModalShell title={`Edit Lifecycle · ${record.linked_name || "Customer"}`} ariaLabel="edit lifecycle" onClose={onClose} onSubmit={submit}><p className="detail-copy">Mark the steps this customer has completed.</p><div className="guide-list">{steps.map((step, index) => <label className="guide-step lifecycle-toggle" key={step}><input type="checkbox" checked={completed.includes(index)} onChange={() => toggle(index)} /><span>{step}</span></label>)}</div></EditModalShell>;
}

function JobsView({ data, go, toast, onSelect, onEdit }: { data: AppData; go: (view: View) => void; toast: (message: string) => void; onSelect: (job: Job) => void; onEdit: (job: Job) => void }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("All");
  const [quoteJob, setQuoteJob] = useState<Job | null>(null);
  const [invoiceJob, setInvoiceJob] = useState<Job | null>(null);
  const filters = ["All", "New Job", "In Progress", "Ready for Pickup", "Delivered", "Paid", "Cancelled"];
  const jobs = data.jobs.filter((job) => {
    const haystack = `${job.customer_name} ${job.job_details || ""} ${job.job_id || ""}`.toLowerCase();
    return haystack.includes(query.toLowerCase()) && (filter === "All" || statusLabel(job.status) === filter);
  });
  const customerFor = (job: Job) => data.customers.find((customer) => (job.customer_id ? customer.id === job.customer_id : customer.customer_name === job.customer_name));
  return <><div className="page-heading"><div><h1>Jobs</h1><p>Track every alteration from intake to pickup.</p></div><div className="page-heading-actions"><button className="button primary" onClick={() => go("new-job")}><Plus size={15} /> New Job</button></div></div><div className="toolbar"><SearchBox value={query} onChange={setQuery} placeholder="Search by name or job details..." /><div className="filter-strip">{filters.map((item) => <button key={item} className={`filter-button ${filter === item ? "active" : ""}`} onClick={() => setFilter(item)}>{item}</button>)}</div></div><div className="stack">{jobs.length === 0 ? <div className="empty">No jobs match your search.</div> : jobs.map((job) => <JobRow key={job.id} job={job} onSelect={onSelect} onEdit={onEdit} onSendQuote={(selected) => setQuoteJob(selected)} onExportInvoice={(selected) => setInvoiceJob(selected)} />)}</div>{quoteJob && <QuoteModal job={quoteJob} customer={customerFor(quoteJob)} onClose={() => setQuoteJob(null)} />}{invoiceJob && <InvoiceModal job={invoiceJob} customer={customerFor(invoiceJob)} onClose={() => setInvoiceJob(null)} />}</>;
}

function CustomersView({ data, go, onSelect, onEdit, onNew }: { data: AppData; go: (view: View) => void; onSelect: (customer: Customer) => void; onEdit: (customer: Customer) => void; onNew: () => void }) {
  const [query, setQuery] = useState("");
  const customers = data.customers.filter((customer) => `${customer.customer_name} ${customer.phone_number || ""} ${customer.email || ""} ${customer.address || ""}`.toLowerCase().includes(query.toLowerCase()));
  return <><div className="page-heading"><div><h1>Customers</h1><p>Your customer book, ready for the next fitting.</p></div><button className="button primary" onClick={onNew}><Plus size={15} /> New Customer</button></div><div className="toolbar"><SearchBox value={query} onChange={setQuery} placeholder="Search customers..." /></div><div className="stack">{customers.length === 0 ? <div className="empty">No customers match your search.</div> : customers.map((customer) => <div key={customer.id} className="customer-row clickable" role="button" tabIndex={0} onClick={() => onSelect(customer)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(customer); } }}><div className="avatar">{initials(customer.customer_name)}</div><div className="customer-row-main"><div className="row-title">{customer.customer_name}</div><div className="row-meta">{customer.phone_number || "No phone"}{customer.address ? ` · ${customer.address}` : ""}</div></div><div className="row-actions"><span className="badge info">{customer.source || "Customer"}</span><button className="button small row-edit-button" aria-label={`Edit ${customer.customer_name}`} onClick={(event) => { event.stopPropagation(); onEdit(customer); }}><Pencil size={13} /> Edit</button><ChevronRight size={16} className="muted" /></div></div>)}</div></>;
}

function LeadsView({ data, go, onSelect, onEdit }: { data: AppData; go: (view: View) => void; onSelect: (lead: Lead) => void; onEdit: (lead: Lead) => void }) {
  const [query, setQuery] = useState("");
  const leads = data.leads.filter((lead) => `${lead.name} ${lead.interested_in || ""} ${lead.source || ""}`.toLowerCase().includes(query.toLowerCase()));
  return <><div className="page-heading"><div><h1>Leads</h1><p>Keep warm inquiries moving toward their first fitting.</p></div><button className="button primary" onClick={() => go("new-lead")}><Plus size={15} /> New Lead</button></div><div className="toolbar"><SearchBox value={query} onChange={setQuery} placeholder="Search leads..." /></div><div className="stack">{leads.length === 0 ? <div className="empty">No leads match your search.</div> : leads.map((lead) => <div key={lead.id} className="lead-row clickable" role="button" tabIndex={0} onClick={() => onSelect(lead)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(lead); } }}><div className="avatar blue">{initials(lead.name)}</div><div className="lead-row-main"><div className="row-title">{lead.name}</div><div className="row-description">{lead.interested_in || "No project details yet."}</div><div className="row-meta">{lead.phone_number || lead.email || "No contact details"}</div></div><div className="row-actions"><span className={`badge ${statusTone(lead.status)}`}>{lead.status || "New"}</span><button className="button small row-edit-button" aria-label={`Edit ${lead.name}`} onClick={(event) => { event.stopPropagation(); onEdit(lead); }}><Pencil size={13} /> Edit</button></div></div>)}</div></>;
}

function DetailBack({ label, onBack }: { label: string; onBack: () => void }) {
  return <button className="button ghost back-button" onClick={onBack}><ArrowLeft size={15} /> Back to {label}</button>;
}

function CustomerDetailView({ customer, data, onBack, onSelectJob, onNewJob, onAddAppointment, onEdit }: { customer: Customer; data: AppData; onBack: () => void; onSelectJob: (job: Job) => void; onNewJob: (customer: Customer) => void; onAddAppointment: (customer: Customer) => void; onEdit: (customer: Customer) => void }) {
  const jobs = data.jobs.filter((job) => jobBelongsTo(job, customer));
  const lifecycle = data.lifecycle.find((record) => linkedTo(record, customer));
  const appointments = data.appointments.filter((appointment) => linkedTo(appointment, customer));
  const totalSpend = jobs.filter((job) => (job.status || "").toLowerCase() === "paid").reduce((sum, job) => sum + numeric(job.amount_to_charge), 0);
  const handleJobClick = (job: Job) => { if (statusLabel(job.status) === "New Job") onNewJob(customer); else onSelectJob(job); };
  const [quoteJob, setQuoteJob] = useState<Job | null>(null);
  const [invoiceJob, setInvoiceJob] = useState<Job | null>(null);
  return <>
    <DetailBack label="Customers" onBack={onBack} />
     <div className="profile-hero card"><div className="avatar profile-avatar">{initials(customer.customer_name)}</div><div className="profile-hero-main"><div className="eyebrow">Customer profile</div><h1>{customer.customer_name}</h1><div className="profile-contact">{customer.phone_number && <span><Phone size={14} />{customer.phone_number}</span>}{customer.email && <span><Mail size={14} />{customer.email}</span>}{customer.address && <span><MapPin size={14} />{customer.address}</span>}</div></div><div className="profile-actions"><span className="badge info">{customer.source || "Customer"}</span><button className="button small primary" onClick={() => onNewJob(customer)}><Plus size={13} /> Create Job</button><button className="button small" onClick={() => onEdit(customer)}><Pencil size={13} /> Edit</button></div></div>
    <div className="metric-grid profile-metrics"><div className="metric-card"><div className="metric-label">Total jobs</div><div className="metric-value">{jobs.length}</div><div className="metric-note">All studio work</div></div><div className="metric-card"><div className="metric-label">Paid to date</div><div className="metric-value">{money(totalSpend)}</div><div className="metric-note">Completed revenue</div></div><div className="metric-card"><div className="metric-label">Open jobs</div><div className="metric-value">{jobs.filter((job) => !isClosed(job.status)).length}</div><div className="metric-note">In progress or new</div></div><div className="metric-card"><div className="metric-label">Lifecycle</div><div className="metric-value">{lifecycle ? `${Math.round(((lifecycle.completed_steps || []).length / steps.length) * 100)}%` : "—"}</div><div className="metric-note">Journey complete</div></div></div>
    <section className="section"><SectionHeading title="Jobs for this customer" />{jobs.length === 0 ? <div className="empty">No jobs recorded for this customer.</div> : <div className="stack">{jobs.map((job) => <JobRow key={job.id} job={{ ...job, status: statusLabel(job.status) }} onSelect={handleJobClick} onSendQuote={(selected) => setQuoteJob(selected)} onExportInvoice={(selected) => setInvoiceJob(selected)} />)}</div>}</section>
     <div className="grid-2 detail-grid"><section className="card"><h3>Notes</h3><p className="detail-copy">{customer.notes || "No notes have been added yet."}</p></section><section className="card"><div className="detail-card-heading"><h3>Upcoming appointments</h3><button className="button small" onClick={() => onAddAppointment(customer)}><Plus size={13} /> Add appointment</button></div>{appointments.length === 0 ? <p className="detail-copy">No appointments scheduled.</p> : appointments.slice(0, 3).map((appointment) => <div className="detail-list-row" key={appointment.id}><CalendarDays size={15} /><span>{appointment.title || "Appointment"}<small>{shortDate(appointment.date)}{appointment.time ? ` · ${appointment.time}` : ""}</small></span></div>)}</section></div>
    {quoteJob && <QuoteModal job={quoteJob} customer={customer} onClose={() => setQuoteJob(null)} />}
    {invoiceJob && <InvoiceModal job={invoiceJob} customer={customer} onClose={() => setInvoiceJob(null)} />}
  </>;
}

function JobDetailView({ job, data, onBack, onSelectJob, onEdit }: { job: Job; data: AppData; onBack: () => void; onSelectJob: (job: Job) => void; onEdit: (job: Job) => void }) {
  const customer = data.customers.find((item) => item.id === job.customer_id || item.customer_name === job.customer_name);
  const relatedJobs = customer ? data.jobs.filter((item) => jobBelongsTo(item, customer)) : [];
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  return <>
    <DetailBack label="Jobs" onBack={onBack} />
     <div className="profile-hero card"><div className="avatar profile-avatar">{initials(job.customer_name)}</div><div className="profile-hero-main"><div className="eyebrow">Job profile</div><h1>{job.customer_name}</h1><div className="profile-contact"><span>{job.job_id ? `#${job.job_id}` : "Job"}</span>{job.delivery_date && <span><CalendarDays size={14} />Due {fullDate(job.delivery_date)}</span>}</div></div><div className="profile-actions"><StatusBadge status={job.status} /><button className="button small" onClick={() => setQuoteOpen(true)}>Create Quote</button><button className="button small" onClick={() => setInvoiceOpen(true)}><FileDown size={13} /> Export Invoice</button><button className="button small" onClick={() => onEdit(job)}><Pencil size={13} /> Edit</button></div></div>
    <div className="detail-columns"><section className="card detail-main-card"><div className="detail-card-heading"><h3>Work details</h3><StatusBadge status={job.status} /></div><p className="detail-copy prominent">{job.job_details || "No job details added yet."}</p>{job.notes && <><div className="detail-label">Notes</div><p className="detail-copy">{job.notes}</p></>} {job.measurement_notes && <><div className="detail-label">Measurement notes</div><p className="detail-copy">{job.measurement_notes}</p></>}</section><section className="card"><h3>Payment</h3><div className="stat-line"><span>Amount</span><strong>{money(job.amount_to_charge)}</strong></div><div className="stat-line"><span>Deposit paid</span><strong>{money(job.deposit_paid)}</strong></div><div className="stat-line"><span>Balance due</span><strong>{money(job.balance_due)}</strong></div>{numeric(job.tip_received) > 0 && <div className="stat-line"><span>Tip</span><strong>{money(job.tip_received)}</strong></div>}<div className="stat-line"><span>Method</span><strong className="stat-small">{job.payment_method || "—"}</strong></div></section></div>
    <section className="section"><SectionHeading title="Other jobs for this customer" />{relatedJobs.filter((item) => item.id !== job.id).length === 0 ? <div className="empty">This is the only job on file.</div> : <div className="stack">{relatedJobs.filter((item) => item.id !== job.id).map((item) => <JobRow key={item.id} job={item} onSelect={onSelectJob} />)}</div>}</section>
    {quoteOpen && <QuoteModal job={job} customer={customer} onClose={() => setQuoteOpen(false)} />}
    {invoiceOpen && <InvoiceModal job={job} customer={customer} onClose={() => setInvoiceOpen(false)} />}
  </>;
}

function LeadDetailView({ lead, onBack, onEdit }: { lead: Lead; onBack: () => void; onEdit: (lead: Lead) => void }) {
  return <>
    <DetailBack label="Leads" onBack={onBack} />
     <div className="profile-hero card"><div className="avatar blue profile-avatar">{initials(lead.name)}</div><div className="profile-hero-main"><div className="eyebrow">Lead profile</div><h1>{lead.name}</h1><div className="profile-contact">{lead.phone_number && <span><Phone size={14} />{lead.phone_number}</span>}{lead.email && <span><Mail size={14} />{lead.email}</span>}{lead.location && <span><MapPin size={14} />{lead.location}</span>}</div></div><div className="profile-actions"><span className={`badge ${statusTone(lead.status)}`}>{lead.status || "New"}</span><button className="button small" onClick={() => onEdit(lead)}><Pencil size={13} /> Edit</button></div></div>
    <div className="detail-columns"><section className="card detail-main-card"><h3>Inquiry</h3><div className="detail-label">Interested in</div><p className="detail-copy prominent">{lead.interested_in || "No project details yet."}</p><div className="detail-label">Source</div><p className="detail-copy">{lead.source || "Unknown"}</p></section><section className="card"><h3>Notes</h3><p className="detail-copy">{lead.notes || "No notes have been added yet."}</p><button className="button primary" style={{ marginTop: 12 }} onClick={() => window.alert("Lead follow-up is ready to connect to your preferred messaging tool.")}>Follow up</button></section></div>
  </>;
}

function AppointmentsView({ data, go, onComplete, onEdit }: { data: AppData; go: (view: View) => void; onComplete: (appointment: Appointment) => void; onEdit: (appointment: Appointment) => void }) {
  return <><div className="page-heading"><div><h1>Appointments</h1><p>Upcoming drop-offs, fittings, and pickups.</p></div><button className="button primary" onClick={() => go("new-appointment")}><Plus size={15} /> New Appointment</button></div><div className="stack">{data.appointments.length === 0 ? <div className="empty">No appointments yet.</div> : data.appointments.map((appointment) => <div className="appointment-row" key={appointment.id}><div className="metric-icon amber"><CalendarDays size={15} /></div><div className="appointment-row-main"><div className="row-title">{appointment.title || "Appointment"}</div><div className="row-description">{appointment.notes || "No notes added."}</div><div className="row-meta">{shortDate(appointment.date)}{appointment.time ? ` · ${appointment.time}` : ""} · {appointment.linked_name || "Unlinked"}</div></div><div className="appointment-actions"><StatusBadge status={appointment.status} />{appointment.status === "Completed" ? <span className="badge success"><CheckCircle2 size={12} /> Completed</span> : <button className="button small" onClick={() => onComplete(appointment)}><CheckCircle2 size={13} /> Completed</button>}<button className="button small" onClick={() => onEdit(appointment)}><Pencil size={13} /> Edit</button><a className="button small" href={googleCalendarUrl(appointment)} target="_blank" rel="noreferrer">Add to Google Calendar <ArrowUpRight size={13} /></a></div></div>)}</div></>;
}

function NewAppointmentView({ data, onCreate, go, initialCustomer }: { data: AppData; onCreate: (appointment: Appointment) => void; go: (view: View) => void; initialCustomer?: Customer | null }) {
  const [customerName, setCustomerName] = useState(initialCustomer?.customer_name || "");
  const [title, setTitle] = useState("Fitting appointment");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [notes, setNotes] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const customer = data.customers.find((item) => item.customer_name === customerName);
    onCreate({ id: `local-appointment-${Date.now()}`, title, date, time, notes, linked_id: customer?.id, linked_name: customerName || "Unlinked", linked_type: customer ? "Customer" : undefined, status: "Scheduled" });
    go("appointments");
  };
  const selectedCustomer = data.customers.find((customer) => customer.customer_name === customerName);
  return <><div className="page-heading"><div><h1>New Appointment</h1><p>Schedule a fitting, drop-off, or pickup and add it to Google Calendar.</p></div><button className="button" onClick={() => go("appointments")}>Cancel</button></div><form className="card form-card" onSubmit={submit}><div className="form-grid"><div className="field full"><label htmlFor="appointment-customer">Customer</label><input id="appointment-customer" list="appointment-customers" value={customerName} onChange={(event) => setCustomerName(event.target.value)} placeholder="Search customers..." /><datalist id="appointment-customers">{data.customers.map((customer) => <option key={customer.id} value={customer.customer_name}>{customer.phone_number || customer.email || ""}</option>)}</datalist>{selectedCustomer && <div className="autocomplete-meta">{selectedCustomer.phone_number || "No phone"}{selectedCustomer.email ? ` · ${selectedCustomer.email}` : ""}</div>}</div><div className="field full"><label htmlFor="appointment-title">Appointment type</label><input id="appointment-title" value={title} onChange={(event) => setTitle(event.target.value)} required /></div><div className="field"><label htmlFor="appointment-date">Date</label><input id="appointment-date" type="date" value={date} onChange={(event) => setDate(event.target.value)} required /></div><div className="field"><label htmlFor="appointment-time">Time</label><input id="appointment-time" type="time" value={time} onChange={(event) => setTime(event.target.value)} /></div><div className="field full"><label htmlFor="appointment-notes">Notes</label><textarea id="appointment-notes" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Add any fitting or pickup details..." /></div></div><div className="form-actions"><button type="button" className="button" onClick={() => go("appointments")}>Cancel</button><button type="submit" className="button primary"><CalendarDays size={15} /> Save Appointment</button></div></form></>;
}

const monthKey = (value?: string) => {
  const match = /^(\d{4})-(\d{2})/.exec(value || "");
  return match ? `${match[1]}-${match[2]}` : "";
};

const monthLabel = (key: string) => new Intl.DateTimeFormat("en-US", { month: "short" }).format(new Date(`${key}-01T12:00:00`));

const monthLong = (key: string) => new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(new Date(`${key}-01T12:00:00`));

function monthlySeries(data: AppData) {
  const buckets = new Map<string, { revenue: number; expenses: number }>();
  const bucket = (key: string) => {
    if (!buckets.has(key)) buckets.set(key, { revenue: 0, expenses: 0 });
    return buckets.get(key)!;
  };
  data.jobs.forEach((job) => {
    if ((job.status || "").toLowerCase() !== "paid") return;
    const key = monthKey(job.delivery_date) || monthKey(job.start_date);
    if (key) bucket(key).revenue += numeric(job.amount_to_charge);
  });
  data.expenses.forEach((expense) => {
    const key = monthKey(expense.date);
    if (key) bucket(key).expenses += numeric(expense.amount);
  });
  return [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([month, totals]) => ({ month, ...totals }));
}

const axisScale = (max: number) => {
  if (!(max > 0)) return { step: 1, top: 1 };
  const raw = max / 4;
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10].map((c) => c * magnitude).find((c) => c >= raw) ?? 10 * magnitude;
  return { step, top: Math.ceil(max / step) * step || step };
};

const compactMoney = (value: number) => {
  if (value >= 1000) {
    const thousands = value / 1000;
    return `$${thousands >= 10 ? Math.round(thousands) : thousands.toFixed(1).replace(/\.0$/, "")}K`;
  }
  return `$${Math.round(value)}`;
};

function FinanceChart({ data }: { data: AppData }) {
  const series = monthlySeries(data);
  if (series.length === 0) return <div className="card chart"><div className="empty">No monthly activity to chart yet.</div></div>;

  const peak = Math.max(0, ...series.flatMap((point) => [point.revenue, point.expenses]));
  const { step, top } = axisScale(peak);
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, index) => index * step);

  const width = 720;
  const height = 300;
  const padLeft = 64;
  const padRight = 18;
  const padTop = 34;
  const padBottom = 42;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;
  const baseline = padTop + plotHeight;
  const groupWidth = plotWidth / series.length;
  const barWidth = Math.min(38, groupWidth * 0.3);
  const barGap = 4;
  const y = (value: number) => baseline - (value / top) * plotHeight;
  const barHeight = (value: number) => Math.max(0, baseline - y(value));
  const axisMoney = (value: number) => (value === 0 ? "$0" : `$${Math.round(value).toLocaleString("en-US")}`);
  const currentMonth = new Date().toISOString().slice(0, 7);

  return <div className="card chart">
    <div className="chart-legend">
      <span className="legend-item"><i className="legend-swatch revenue" />Revenue</span>
      <span className="legend-item"><i className="legend-swatch expenses" />Expenses</span>
    </div>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Monthly revenue compared with monthly expenses">
      <defs>
        <linearGradient id="chartRevenueFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#dfa8a2" />
          <stop offset="100%" stopColor="#c07a74" />
        </linearGradient>
        <linearGradient id="chartExpensesFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#e2c079" />
          <stop offset="100%" stopColor="#bf8c26" />
        </linearGradient>
      </defs>

      {series.map((point, index) => point.month === currentMonth
        ? <rect key="current-month" className="chart-highlight" x={padLeft + groupWidth * index + 3} y={padTop} width={groupWidth - 6} height={plotHeight} rx="12" />
        : null)}

      {ticks.map((tick) => <g key={`tick-${tick}`}>
        <line x1={padLeft} x2={width - padRight} y1={y(tick)} y2={y(tick)} className={tick === 0 ? "chart-grid base" : "chart-grid"} />
        <text x={padLeft - 12} y={y(tick) + 4} textAnchor="end" className="chart-axis">{axisMoney(tick)}</text>
      </g>)}

      {series.map((point, index) => {
        const center = padLeft + groupWidth * index + groupWidth / 2;
        const revenueX = center - barWidth - barGap / 2;
        const expensesX = center + barGap / 2;
        const revenueTop = y(point.revenue);
        const expensesTop = y(point.expenses);
        const isCurrent = point.month === currentMonth;
        return <g key={point.month}>
          <rect className="chart-bar revenue" x={revenueX} y={revenueTop} width={barWidth} height={barHeight(point.revenue)} rx="5" fill="url(#chartRevenueFill)">
            <title>{`${monthLong(point.month)} — revenue ${money(point.revenue)}`}</title>
          </rect>
          <rect className="chart-bar expenses" x={expensesX} y={expensesTop} width={barWidth} height={barHeight(point.expenses)} rx="5" fill="url(#chartExpensesFill)">
            <title>{`${monthLong(point.month)} — expenses ${money(point.expenses)}`}</title>
          </rect>
          {point.revenue > 0 && <text x={revenueX + barWidth / 2} y={revenueTop - 8} textAnchor="middle" className="chart-value">{compactMoney(point.revenue)}</text>}
          {point.expenses > 0 && <text x={expensesX + barWidth / 2} y={expensesTop - 8} textAnchor="middle" className="chart-value">{compactMoney(point.expenses)}</text>}
          <text x={center} y={height - 15} textAnchor="middle" className={isCurrent ? "chart-axis current" : "chart-axis"}>{monthLabel(point.month)}</text>
        </g>;
      })}
    </svg>
  </div>;
}

function FinancesView({ data, go, onEditExpense, onManageCategories, toast }: { data: AppData; go: (view: View) => void; onEditExpense: (expense: Expense) => void; onManageCategories: () => void; toast: (message: string) => void }) {
  const revenue = data.jobs.filter((job) => (job.status || "").toLowerCase() === "paid").reduce((sum, job) => sum + numeric(job.amount_to_charge), 0);
  const expenses = data.expenses.reduce((sum, expense) => sum + numeric(expense.amount), 0);
  const netProfit = revenue - expenses;
  const generated = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric" }).format(new Date());
  const exportFinancials = () => {
    const rows: string[][] = [["Month", "Revenue", "Expenses", "Net"]];
    monthlySeries(data).forEach((point) => rows.push([point.month, point.revenue.toFixed(2), point.expenses.toFixed(2), (point.revenue - point.expenses).toFixed(2)]));
    rows.push([], ["Total Revenue", revenue.toFixed(2)], ["Total Expenses", expenses.toFixed(2)], ["Net Profit", netProfit.toFixed(2)]);
    const csv = rows.map((row) => row.map((cell) => `"${String(cell ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `balance-sheet-all-time-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    toast("Balance sheet exported as CSV.");
  };
  return <><div className="page-heading"><div><h1>Balance Sheet</h1><p>All Time · Generated {generated}</p></div><button className="button primary" onClick={() => go("new-expense")}><Plus size={15} /> Add Expense</button></div><div className="grid-2"><div className="card"><div className="eyebrow">Total Revenue</div><div className="metric-value">{money(revenue)}</div><div className="stat-line"><span>Total Expenses</span><strong>{money(expenses)}</strong></div><div className="stat-line net"><span>Net Profit</span><strong>{money(netProfit)}</strong></div></div><div className="card"><h3>Quick actions</h3><button className="button" style={{ width: "100%", justifyContent: "space-between", marginBottom: 8 }} onClick={exportFinancials}><span><FileDown size={15} /> Export financials</span><ArrowUpRight size={14} /></button><button className="button" style={{ width: "100%", justifyContent: "space-between" }} onClick={onManageCategories}><span><Tag size={15} /> Manage categories</span><ArrowUpRight size={14} /></button></div></div><section className="section"><SectionHeading title="Revenue vs Expenses" /><FinanceChart data={data} /></section><section className="section"><SectionHeading title="Recent Expenses" /><div className="stack">{data.expenses.length === 0 ? <div className="empty">No expenses recorded.</div> : data.expenses.map((expense) => <div className="expense-row" key={expense.id}><div className="metric-icon rose"><CircleDollarSign size={15} /></div><div className="expense-row-main"><div className="row-title">{expense.note || "Expense"}</div><div className="row-meta">{shortDate(expense.date)} · {expense.category || "Other"}</div></div><strong>{money(expense.amount)}</strong><button className="button small" aria-label={`Edit ${expense.note || "expense"}`} onClick={() => onEditExpense(expense)}><Pencil size={13} /> Edit</button></div>)}</div></section></>;
}

function WaitingView({ entries, customers, go, onEdit }: { entries: WaitingEntry[]; customers: Customer[]; go: (view: View) => void; onEdit: (entry: WaitingEntry) => void }) {
  return <><div className="page-heading"><div><h1>Waiting List</h1><p>Keep track of customers waiting for an opening or a material.</p></div><button className="button primary" onClick={() => go("new-waiting")}><Plus size={15} /> Add to list</button></div>{entries.length === 0 ? <div className="empty"><ListFilter size={28} style={{ marginBottom: 10, color: "var(--rose)" }} /><div>No one is waiting right now.</div><div style={{ marginTop: 6, fontSize: 13 }}>New requests can be added here while you plan the next fitting.</div></div> : <div className="stack">{entries.map((entry) => <div className="waiting-row" key={entry.id}><div className="avatar">{initials(entry.name)}</div><div className="waiting-row-main"><div className="row-title">{entry.name}</div><div className="row-description">{entry.request}</div><div className="row-meta">{entry.contact || "No contact details"} · Added {shortDate(entry.addedDate)}</div></div><button className="button small" aria-label={`Edit ${entry.name}`} onClick={() => onEdit(entry)}><Pencil size={13} /> Edit</button></div>)}</div>}</>;
}

type BookingRow = { id: string; slot_date: string; slot_time: string; kind: string; customer_name: string; phone_number?: string; email?: string; location?: string; notes?: string; status: string };

function BookingHoursEditor() {
  const [draft, setDraft] = useState<BookingRules | null>(null);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  // Which month the date calendar is showing, and which date is being edited.
  const [calMonth, setCalMonth] = useState<number | null>(null);
  const [dateMode, setDateMode] = useState<"week" | "closed" | "custom">("week");
  /** Taken slots per date, so the calendar shows real demand as well as hours. */
  const [bookedByDate, setBookedByDate] = useState<Record<string, number>>({});
  const [dateOpen, setDateOpen] = useState("10:00");
  const [dateClose, setDateClose] = useState("14:00");
  // Days ticked in the regular-week picker, and the hours to give them.
  const [weekDays, setWeekDays] = useState<number[]>([]);
  const [weekOpen, setWeekOpen] = useState("09:00");
  const [weekClose, setWeekClose] = useState("17:00");
  // Dates ticked in the calendar, so several can be changed at once.
  const [pickedDates, setPickedDates] = useState<string[]>([]);

  useEffect(() => {
    if (!supabase) return;
    let cancelled = false;
    void supabase.from("booking_settings").select("*").eq("id", "default").maybeSingle().then(({ data }) => {
      if (!cancelled) setDraft(bookingRulesFrom(data as Record<string, unknown> | null));
    });
    return () => { cancelled = true; };
  }, []);

  // Start the date calendar on the current month.
  useEffect(() => {
    if (calMonth === null) setCalMonth(monthIndexOf(dateKey(new Date())));
  }, [calMonth]);

  // Which dates already have bookings, so the calendar reflects demand and not
  // just opening hours. Declined requests do not hold a slot.
  useEffect(() => {
    if (!supabase) return;
    let cancelled = false;
    void supabase.rpc("studio_bookings").then(({ data }) => {
      if (cancelled || !data) return;
      const counts: Record<string, number> = {};
      for (const row of data as BookingRow[]) {
        if (row.status === "Declined") continue;
        counts[row.slot_date] = (counts[row.slot_date] || 0) + 1;
      }
      setBookedByDate(counts);
    });
    return () => { cancelled = true; };
  }, []);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!supabase || !draft) return;
    // An empty week would silently fall back to the defaults on the public
    // page, which looks like the setting was simply ignored.
    if (draft.dayHours.every((hours) => hours === null)) { setError("Set at least one open day."); setNote(""); return; }
    if (draft.dayHours.some((hours) => hours !== null && toMinutes(hours.close) <= toMinutes(hours.open))) {
      setError("A closing time is before its opening time."); setNote(""); return;
    }
    setSaving(true); setError(""); setNote("");
    const { data, error: rpcError } = await supabase.rpc("studio_save_booking_settings", {
      patch: {
        slot_minutes: draft.slotMinutes,
        day_hours: draft.dayHours,
        exceptions: Object.values(draft.exceptions),
        lead_hours: draft.leadHours,
        horizon_days: draft.horizonDays,
      },
    });
    setSaving(false);
    if (rpcError || data !== true) { setError("Could not save those hours. Try again."); return; }
    setNote("Saved. The booking page picks these up straight away.");
  };

  if (!draft) return <div className="card"><div className="booking-muted">Loading hours…</div></div>;

  const toggleWeekDay = (day: number) => setWeekDays((current) => current.includes(day) ? current.filter((item) => item !== day) : [...current, day].sort((a, b) => a - b));

  const applyToWeek = () => {
    if (weekDays.length === 0) return;
    if (toMinutes(weekClose) <= toMinutes(weekOpen)) { setError("A closing time is before its opening time."); setNote(""); return; }
    const next = [...draft.dayHours];
    for (const day of weekDays) next[day] = { open: weekOpen, close: weekClose };
    setDraft({ ...draft, dayHours: next });
    setError("");
  };

  const closeWeekDays = () => {
    if (weekDays.length === 0) return;
    const next = [...draft.dayHours];
    for (const day of weekDays) next[day] = null;
    setDraft({ ...draft, dayHours: next });
    setError("");
  };

  const noOpenDays = draft.dayHours.every((hours) => hours === null);
  const badWindow = draft.dayHours.some((hours) => hours !== null && toMinutes(hours.close) <= toMinutes(hours.open));
  const exceptionList = Object.values(draft.exceptions).sort((a, b) => a.date.localeCompare(b.date));
  const dateCells = calMonth === null ? [] : monthGrid(Math.floor(calMonth / 12), calMonth % 12);
  // The calendar is for planning ahead, so anything before today is inert.
  const todayKey = dateKey(new Date());
  const thisMonth = monthIndexOf(todayKey);

  /** Ticking dates accumulates, so several can be changed in one go. */
  const toggleDate = (key: string) => setPickedDates((current) => {
    if (current.includes(key)) return current.filter((item) => item !== key);
    // Seed the time boxes from the first date picked, so it is not a guess.
    const existing = draft.exceptions[key];
    if (current.length === 0 && existing?.open && existing?.close) { setDateOpen(existing.open); setDateClose(existing.close); }
    return [...current, key].sort();
  });

  const applyDate = () => {
    if (pickedDates.length === 0) return;
    if (dateMode === "custom" && toMinutes(dateClose) <= toMinutes(dateOpen)) {
      setError("That date's closing time is before its opening time."); setNote(""); return;
    }
    const next = { ...draft.exceptions };
    for (const key of pickedDates) {
      if (dateMode === "week") delete next[key];
      else if (dateMode === "closed") next[key] = { date: key, open: null, close: null };
      else next[key] = { date: key, open: dateOpen, close: dateClose };
    }
    setDraft({ ...draft, exceptions: next });
    setPickedDates([]);
    setError("");
  };

  const clearDate = () => {
    const next = { ...draft.exceptions };
    for (const key of pickedDates) delete next[key];
    setDraft({ ...draft, exceptions: next });
    setPickedDates([]);
  };

  return <form className="card hours-card" onSubmit={save}>
    <div className="eyebrow">Booking hours</div>
    <p className="row-meta" style={{ marginTop: 8 }}>Set your own hours for each day — tap a day to open or close it. Customers can only pick times inside these windows.</p>

    <div className="week-picker">
      <div className="week-chips">{dayNames.map((label, day) => {
        const hours = draft.dayHours[day];
        const picked = weekDays.includes(day);
        return <button
          key={label}
          type="button"
          className={`week-chip${hours ? " open" : ""}${picked ? " picked" : ""}`}
          aria-pressed={picked}
          aria-label={`${label}, ${hours ? `${formatSlot(hours.open)} to ${formatSlot(hours.close)}` : "closed"}`}
          onClick={() => toggleWeekDay(day)}
        ><span>{label.slice(0, 3)}</span><small>{hours ? `${formatSlot(hours.open).replace(":00", "")}–${formatSlot(hours.close).replace(":00", "")}` : "Closed"}</small></button>;
      })}</div>
      <div className="week-apply">
        <input type="time" aria-label="Weekly opening time" value={weekOpen} onChange={(event) => setWeekOpen(event.target.value)} />
        <span className="hours-sep">to</span>
        <input type="time" aria-label="Weekly closing time" value={weekClose} onChange={(event) => setWeekClose(event.target.value)} />
        <button type="button" className="button small primary" onClick={applyToWeek} disabled={weekDays.length === 0}>Open {weekDays.length || 0} selected</button>
        <button type="button" className="button small" onClick={closeWeekDays} disabled={weekDays.length === 0}>Close {weekDays.length || 0}</button>
      </div>
      <p className="row-meta">{weekDays.length === 0 ? "Tap the days you want to change, then set their hours once." : `${weekDays.length} day${weekDays.length === 1 ? "" : "s"} selected.`}</p>
    </div>

    <div className="hours-row" style={{ marginTop: 16 }}>
      <div className="field"><label htmlFor="hours-slot">Slot length</label>
        <select id="hours-slot" value={draft.slotMinutes} onChange={(event) => setDraft({ ...draft, slotMinutes: Number(event.target.value) })}>
          {[10, 15, 20, 30].map((minutes) => <option key={minutes} value={minutes}>{minutes} minutes</option>)}
        </select></div>
      <div className="field"><label htmlFor="hours-lead">Minimum notice</label>
        <select id="hours-lead" value={draft.leadHours} onChange={(event) => setDraft({ ...draft, leadHours: Number(event.target.value) })}>
          {[0, 2, 4, 12, 24, 48, 72].map((hours) => <option key={hours} value={hours}>{hours === 0 ? "No minimum" : `${hours} hours`}</option>)}
        </select></div>
      <div className="field"><label htmlFor="hours-horizon">Book ahead</label>
        <select id="hours-horizon" value={draft.horizonDays} onChange={(event) => setDraft({ ...draft, horizonDays: Number(event.target.value) })}>
          {[14, 30, 60, 90, 180].map((days) => <option key={days} value={days}>{days} days</option>)}
        </select></div>
    </div>

    <div className="field" style={{ marginTop: 18 }}>
      <label>Dates you are open or closed</label>
      <p className="row-meta" style={{ margin: "4px 0 10px" }}>Your weekly hours apply to every date by default. Tap a date to close it, or give it its own times.</p>

      <div className="date-cal">
        <div className="date-cal-head">
          <button type="button" className="booking-cal-nav" aria-label="Previous month" disabled={calMonth === null || calMonth <= thisMonth} onClick={() => setCalMonth((month) => (month === null ? month : month - 1))}>‹</button>
          <div className="booking-cal-title">{calMonth === null ? "" : monthTitle(Math.floor(calMonth / 12), calMonth % 12)}</div>
          <button type="button" className="booking-cal-nav" aria-label="Next month" onClick={() => setCalMonth((month) => (month === null ? month : month + 1))}>›</button>
        </div>
        <div className="booking-cal-dow">{["S", "M", "T", "W", "T", "F", "S"].map((label, index) => <span key={index}>{label}</span>)}</div>
        <div className="booking-cal-grid">{dateCells.map((key) => {
          const inMonth = calMonth !== null && monthIndexOf(key) === calMonth;
          const hours = hoursForDate(key, draft);
          const custom = key in draft.exceptions;
          const isPast = key < todayKey;
          const booked = isPast ? 0 : bookedByDate[key] || 0;
          return <button
            key={key}
            type="button"
            disabled={!inMonth || isPast}
            aria-label={`${prettyDayLong(key)} — ${hours ? `${formatSlot(hours.open)} to ${formatSlot(hours.close)}` : "closed"}${isPast ? ", in the past" : booked ? `, ${booked} booked` : ""}`}
            className={`date-day${hours ? "" : " off"}${custom ? " custom" : ""}${isPast ? " past" : ""}${pickedDates.includes(key) ? " picked" : ""}${booked ? " has-bookings" : ""}${inMonth ? "" : " outside"}`}
            onClick={() => toggleDate(key)}
          ><span className="date-day-num">{parseDateKey(key).getDate()}</span>{booked > 0 && <span className="date-day-booked">{booked}</span>}</button>;
        })}</div>
        <div className="date-legend">
          <span><i className="date-dot weekly" />Weekly hours</span>
          <span><i className="date-dot custom" />Own hours</span>
          <span><i className="date-dot off" />Closed</span>
          <span><i className="date-dot blocked" />Blocked by you</span>
          <span><i className="date-dot booked" />Booked</span>
        </div>
      </div>

      {pickedDates.length > 0 && <div className="date-editor">
        <div className="date-editor-head">
          <strong>{pickedDates.length === 1 ? prettyDayLong(pickedDates[0]) : `${pickedDates.length} dates picked`}</strong>
          <button type="button" className="icon-button" aria-label="Clear date selection" onClick={() => setPickedDates([])}><X size={16} /></button>
        </div>
        <label className="date-choice"><input type="radio" name="date-mode" checked={dateMode === "week"} onChange={() => setDateMode("week")} /><span>Use my weekly hours</span></label>
        <label className="date-choice"><input type="radio" name="date-mode" checked={dateMode === "closed"} onChange={() => setDateMode("closed")} /><span>Closed all day</span></label>
        <label className="date-choice"><input type="radio" name="date-mode" checked={dateMode === "custom"} onChange={() => setDateMode("custom")} /><span>Different hours</span></label>
        {dateMode === "custom" && <div className="date-editor-times">
          <input type="time" aria-label="Date opening time" value={dateOpen} onChange={(event) => setDateOpen(event.target.value)} />
          <span className="hours-sep">to</span>
          <input type="time" aria-label="Date closing time" value={dateClose} onChange={(event) => setDateClose(event.target.value)} />
        </div>}
        <div className="date-editor-actions">
          <button type="button" className="button small primary" onClick={applyDate}>Apply to {pickedDates.length} {pickedDates.length === 1 ? "date" : "dates"}</button>
          {pickedDates.some((key) => key in draft.exceptions) && <button type="button" className="button small" onClick={clearDate}>Clear override</button>}
        </div>
      </div>}

      <div className="row-meta" style={{ marginTop: 10 }}>
        {exceptionList.length === 0 ? "No dates differ from your weekly hours." : `${exceptionList.length} date${exceptionList.length === 1 ? "" : "s"} differ from your weekly hours.`}
      </div>
    </div>

    <div className="row-meta" style={{ marginTop: 14 }}>
      Customers will see <strong>{openingHoursLabel(draft)}</strong>{closedDaysLabel(draft) ? ` · ${closedDaysLabel(draft)}` : ""}
    </div>
    {noOpenDays && <div className="booking-alert error" style={{ marginTop: 12 }}>Set at least one open day.</div>}
    {badWindow && <div className="booking-alert error" style={{ marginTop: 12 }}>A closing time is before its opening time.</div>}
    {error && <div className="booking-alert error" style={{ marginTop: 12 }}>{error}</div>}
    {note && <div className="booking-area ok" style={{ marginTop: 12 }}><CheckCircle2 size={14} /> {note}</div>}
    <div className="form-actions"><button type="submit" className="button primary" disabled={saving || noOpenDays || badWindow}>{saving ? "Saving…" : "Save hours"}</button></div>
  </form>;
}

/** Self-service password change. `recovery` is true when arriving from an email reset link. */
function ChangePasswordModal({ email, recovery, onClose }: { email: string; recovery: boolean; onClose: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!supabase) return;
    setError("");
    if (next.length < 8) { setError("Use at least 8 characters."); return; }
    if (next !== confirm) { setError("The two new passwords do not match."); return; }
    setBusy(true);
    // Coming from an email link there is no current password to check.
    if (!recovery) {
      const { error: verifyError } = await supabase.auth.signInWithPassword({ email, password: current });
      if (verifyError) { setBusy(false); setError("That current password is not right."); return; }
    }
    const { error: updateError } = await supabase.auth.updateUser({ password: next });
    setBusy(false);
    if (updateError) { setError(updateError.message); return; }
    setDone(true);
  };

  if (done) return <EditModalShell title="Password changed" ariaLabel="password changed" onClose={onClose} onSubmit={(event) => { event.preventDefault(); onClose(); }} submitLabel="Done">
    <p className="row-meta">Your new password is active. Use it the next time you sign in.</p>
  </EditModalShell>;

  return <EditModalShell title={recovery ? "Set a new password" : "Change password"} ariaLabel="change password" onClose={onClose} onSubmit={submit} submitLabel={busy ? "Saving…" : "Save password"}>
    <p className="row-meta" style={{ marginBottom: 14 }}>{recovery ? "Choose a new password for" : "Changing the password for"} <strong>{email}</strong>.</p>
    {!recovery && <div className="field"><label htmlFor="pw-current">Current password</label><input id="pw-current" type="password" value={current} onChange={(event) => setCurrent(event.target.value)} autoComplete="current-password" required /></div>}
    <div className="field"><label htmlFor="pw-new">New password</label><input id="pw-new" type="password" value={next} onChange={(event) => setNext(event.target.value)} placeholder="At least 8 characters" autoComplete="new-password" required /></div>
    <div className="field"><label htmlFor="pw-confirm">Confirm new password</label><input id="pw-confirm" type="password" value={confirm} onChange={(event) => setConfirm(event.target.value)} autoComplete="new-password" required /></div>
    {error && <div className="booking-alert error" style={{ marginTop: 12 }}>{error}</div>}
  </EditModalShell>;
}

function BookingsView() {
  const [rows, setRows] = useState<BookingRow[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [shareUrl, setShareUrl] = useState("/book");

  useEffect(() => { setShareUrl(`${window.location.origin}/book`); }, []);

  const load = useCallback(async () => {
    if (!supabase) return;
    setBusy(true);
    const result = await supabase.rpc("studio_bookings");
    if (result.error) { setError("Could not load bookings right now."); setBusy(false); return; }
    setRows((result.data || []) as BookingRow[]);
    setError("");
    setBusy(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const changeStatus = async (id: string, status: string) => {
    if (!supabase) return;
    await supabase.rpc("studio_set_booking_status", { booking_id: id, new_status: status });
    void load();
  };

  const copyLink = async () => {
    try { await navigator.clipboard.writeText(shareUrl); setCopied(true); window.setTimeout(() => setCopied(false), 2000); }
    catch { setError("Could not copy automatically — long-press the link to copy it."); }
  };

  const visible = (rows || []).filter((row) => row.status !== "Declined");
  const pendingCount = (rows || []).filter((row) => row.status === "Requested").length;

  return <>
    <div className="page-heading"><div><h1>Bookings</h1><p>Drop-off and pick-up times customers chose from your booking link.</p></div></div>

    <div className="card" style={{ marginBottom: 12 }}>
      <div className="eyebrow">Your booking link</div>
      <div className="booking-link-row">
        <code className="booking-link">{shareUrl}</code>
        <button className="button" onClick={copyLink}>{copied ? "Copied" : "Copy link"}</button>
      </div>
      <div className="row-meta">Send this to customers, or put it in your Instagram bio.</div>
    </div>

    {!supabase && <div className="empty">
      Online booking is not connected yet. Add <strong>NEXT_PUBLIC_SUPABASE_URL</strong> and <strong>NEXT_PUBLIC_SUPABASE_ANON_KEY</strong>, then run <strong>supabase/schema-bookings.sql</strong>.
    </div>}

    {supabase && <>
      {error && <div className="booking-alert error">{error}</div>}
      <div className="section-heading" style={{ marginTop: 4 }}>
        <h2>{busy && rows === null ? "Loading…" : `${pendingCount} awaiting confirmation`}</h2>
      </div>
      <div className="stack">{rows !== null && visible.length === 0 ? <div className="empty">No booking requests yet.</div> : visible.map((row) => <div className="booking-request" key={row.id}>
        <div className="booking-request-when">
          <div className="row-title">{formatSlot(row.slot_time)}</div>
          <div className="row-meta">{prettyDay(row.slot_date)}</div>
        </div>
        <div className="booking-request-main">
          <div className="row-title">{row.customer_name} <span className="muted">{row.kind}</span></div>
          <div className="row-meta">{row.phone_number || row.email || "No contact details"}</div>
          {row.location && <div className="row-meta"><MapPin size={12} style={{ verticalAlign: "-2px", marginRight: 4 }} />{row.location}</div>}
          {row.notes && <div className="row-description">{row.notes}</div>}
        </div>
        <div className="row-actions">
          <span className={`badge ${row.status === "Confirmed" ? "success" : statusTone(row.status)}`}>{row.status}</span>
          {row.status !== "Confirmed" && <button className="button small" onClick={() => changeStatus(row.id, "Confirmed")}><CheckCircle2 size={13} /> Confirm</button>}
          <button className="button small" onClick={() => changeStatus(row.id, "Declined")}><X size={13} /> Decline</button>
        </div>
      </div>)}</div>
      <BookingHoursEditor />
    </>}
  </>;
}

function TeamView() {
  return <><div className="page-heading"><div><h1>Team</h1><p>People who keep Rachel&apos;s Seamstress Studio moving.</p></div></div><div className="grid-2"><div className="card"><div className="avatar">RV</div><h3 style={{ marginTop: 12 }}>Rachel Valenzuela</h3><div className="muted">Owner · Studio manager</div><div className="stat-line" style={{ marginTop: 14 }}><span>Access</span><strong>Admin</strong></div></div><div className="card"><div className="avatar green">AS</div><h3 style={{ marginTop: 12 }}>Alterations team</h3><div className="muted">Shared workspace</div><div className="stat-line" style={{ marginTop: 14 }}><span>Open jobs</span><strong>3</strong></div></div></div></>;
}

function LifecycleView({ data, onEdit }: { data: AppData; onEdit: (record: Lifecycle) => void }) {
  const records = data.lifecycle.slice().sort((a, b) => (a.linked_name || "").localeCompare(b.linked_name || ""));
  const [guideOpen, setGuideOpen] = useState(false);
  const guide = ["New inquiry — capture the request and contact details.", "Measurements — record the fitting measurements and preferences.", "Quote — confirm scope, pricing, and the expected delivery date.", "In progress — keep notes on the work as it moves through the studio.", "Ready — notify the customer that the piece is ready for pickup.", "Delivered — close out payment and mark the customer journey complete."];
  return <><div className="page-heading"><div><h1>Lifecycle</h1><p>See where each customer is in their studio journey.</p></div><button className="button" onClick={() => setGuideOpen(true)}><Sparkles size={15} /> Workflow guide</button></div><div className="stack">{records.length === 0 ? <div className="empty">No lifecycle records yet.</div> : records.map((record) => { const completed = record.completed_steps || []; const percent = Math.round((completed.length / steps.length) * 100); return <div className="lifecycle-row" key={record.id}><div className="avatar blue">{initials(record.linked_name || "Customer")}</div><div className="lifecycle-main"><div className="row-title">{record.linked_name || "Customer"}</div><div className="row-meta">{completed.length} of {steps.length} steps complete</div><div className="progress"><span style={{ width: `${percent}%` }} /></div><div className="step-dots">{steps.map((_, index) => <span key={index} className={`step-dot ${completed.includes(index) ? "complete" : ""}`} />)}</div></div><span className="badge info">{percent}%</span><button className="button small" aria-label={`Edit lifecycle for ${record.linked_name || "customer"}`} onClick={() => onEdit(record)}><Pencil size={13} /> Edit</button></div>; })}</div>{guideOpen && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setGuideOpen(false)}><div className="modal" role="dialog" aria-modal="true" aria-label="Lifecycle workflow guide"><div className="modal-heading"><h2>Workflow guide</h2><button className="icon-button" aria-label="Close workflow guide" onClick={() => setGuideOpen(false)}><X size={18} /></button></div><p className="detail-copy">Move each customer through these six steps as their project progresses.</p><div className="guide-list">{guide.map((item, index) => <div className="guide-step" key={item}><span className="guide-number">{index + 1}</span><span>{item}</span></div>)}</div></div></div>}</>;
}

function NewJobView({ data, onCreate, go, initialCustomer }: { data: AppData; onCreate: (job: Job) => void; go: (view: View) => void; initialCustomer?: Customer | null }) {
  const [customerName, setCustomerName] = useState(initialCustomer?.customer_name || "");
  const [details, setDetails] = useState("");
  const [amount, setAmount] = useState("");
  const [tip, setTip] = useState("");
  const [deliveryDate, setDeliveryDate] = useState("");
  const [status, setStatus] = useState("New Job");
  const [payment, setPayment] = useState("Cash");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const customer = data.customers.find((item) => item.customer_name === customerName);
    onCreate({ id: `local-${Date.now()}`, job_id: nextJobNumber(data.jobs), customer_id: customer?.id, customer_name: customerName || "New customer", job_details: details, status, amount_to_charge: Number(amount || 0), tip_received: Number(tip || 0), balance_due: status.trim().toLowerCase() === "paid" ? 0 : Number(amount || 0), delivery_date: deliveryDate, payment_method: payment });
    go("jobs");
  };
  const selectedCustomer = data.customers.find((customer) => customer.customer_name === customerName);
  return <><div className="page-heading"><div><h1>Add Job</h1><p>Capture the work, price, and pickup date in one place.</p></div><button className="button" onClick={() => go("jobs")}>Cancel</button></div><form className="card form-card" onSubmit={submit}><div className="form-grid"><div className="field"><label htmlFor="customer">Customer</label><input id="customer" list="job-customers" value={customerName} onChange={(event) => setCustomerName(event.target.value)} placeholder="Search customers..." required /><datalist id="job-customers">{data.customers.map((customer) => <option key={customer.id} value={customer.customer_name}>{customer.phone_number || customer.email || ""}</option>)}</datalist>{selectedCustomer && <div className="autocomplete-meta">{selectedCustomer.phone_number || "No phone"}{selectedCustomer.email ? ` · ${selectedCustomer.email}` : ""}{selectedCustomer.address ? ` · ${selectedCustomer.address}` : ""}</div>}</div><div className="field"><label htmlFor="status">Status</label><select id="status" value={status} onChange={(event) => setStatus(event.target.value)}><option>New Job</option><option>In Progress</option><option>Ready for Pickup</option><option>Delivered</option><option>Paid</option></select></div><div className="field full"><label htmlFor="details">Job details</label><textarea id="details" value={details} onChange={(event) => setDetails(event.target.value)} placeholder="Describe the alterations or project..." required /></div><div className="field"><label htmlFor="amount">Amount to charge</label><input id="amount" type="number" min="0" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00" /></div><div className="field"><label htmlFor="tip">Tip</label><input id="tip" type="number" min="0" step="0.01" value={tip} onChange={(event) => setTip(event.target.value)} placeholder="0.00" /></div><div className="field"><label htmlFor="delivery">Delivery date</label><input id="delivery" type="date" value={deliveryDate} onChange={(event) => setDeliveryDate(event.target.value)} /></div><div className="field"><label htmlFor="payment">Payment method</label><select id="payment" value={payment} onChange={(event) => setPayment(event.target.value)}><option>Cash</option><option>Card</option><option>Check</option><option>Venmo</option><option>Other</option></select></div></div><div className="form-actions"><button type="button" className="button" onClick={() => go("jobs")}>Cancel</button><button type="submit" className="button primary"><Plus size={15} /> Save Job</button></div></form></>;
}

function NewExpenseView({ categories, onCreate, go }: { categories: string[]; onCreate: (expense: Expense) => void; go: (view: View) => void }) {
  const [note, setNote] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [category, setCategory] = useState(() => categories[0] || "Other");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onCreate({ id: `local-expense-${Date.now()}`, note, amount: Number(amount), date, category });
    go("finances");
  };
  return <><div className="page-heading"><div><h1>Add Expense</h1><p>Record a studio cost so your finances stay up to date.</p></div><button className="button" onClick={() => go("finances")}>Cancel</button></div><form className="card form-card" onSubmit={submit}><div className="form-grid"><div className="field full"><label htmlFor="expense-note">Description</label><input id="expense-note" value={note} onChange={(event) => setNote(event.target.value)} placeholder="e.g. Silk lining for bridal gown" required /></div><div className="field"><label htmlFor="expense-amount">Amount</label><input id="expense-amount" type="number" min="0.01" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00" required /></div><div className="field"><label htmlFor="expense-date">Date</label><input id="expense-date" type="date" value={date} onChange={(event) => setDate(event.target.value)} required /></div><div className="field"><label htmlFor="expense-category">Category</label><select id="expense-category" value={category} onChange={(event) => setCategory(event.target.value)}>{categories.map((name) => <option key={name}>{name}</option>)}</select></div></div><div className="form-actions"><button type="button" className="button" onClick={() => go("finances")}>Cancel</button><button type="submit" className="button primary"><Plus size={15} /> Save Expense</button></div></form></>;
}

function NewLeadView({ data, onCreate, go }: { data: AppData; onCreate: (lead: Lead) => void; go: (view: View) => void }) {
  const [name, setName] = useState("");
  const [status, setStatus] = useState("New");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [location, setLocation] = useState("");
  const [source, setSource] = useState("Phone");
  const [interestedIn, setInterestedIn] = useState("");
  const [notes, setNotes] = useState("");
  const knownCustomer = data.customers.find((customer) => customer.customer_name === name);
  const updateName = (value: string) => {
    setName(value);
    const customer = data.customers.find((item) => item.customer_name === value);
    if (!customer) return;
    if (!phone) setPhone(customer.phone_number || "");
    if (!email) setEmail(customer.email || "");
    if (!location) setLocation(customer.address || "");
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onCreate({ id: `local-lead-${Date.now()}`, name, status, phone_number: phone, email, location, source, interested_in: interestedIn, notes });
    go("leads");
  };
  return <><div className="page-heading"><div><h1>New Lead</h1><p>Capture an enquiry before it goes cold.</p></div><button className="button" onClick={() => go("leads")}>Cancel</button></div><form className="card form-card" onSubmit={submit}><div className="form-grid"><div className="field"><label htmlFor="lead-name">Name</label><input id="lead-name" list="lead-customer-names" value={name} onChange={(event) => updateName(event.target.value)} placeholder="Who is enquiring?" required /><datalist id="lead-customer-names">{data.customers.map((customer) => <option key={customer.id} value={customer.customer_name}>{customer.phone_number || customer.email || ""}</option>)}</datalist>{knownCustomer && <div className="autocomplete-meta">Existing customer · {knownCustomer.phone_number || "No phone"}{knownCustomer.email ? ` · ${knownCustomer.email}` : ""}</div>}</div><div className="field"><label htmlFor="lead-status">Status</label><select id="lead-status" value={status} onChange={(event) => setStatus(event.target.value)}><option>New</option><option>Contacted</option><option>Qualified</option><option>Converted</option><option>Lost</option></select></div><div className="field"><label htmlFor="lead-phone">Phone</label><input id="lead-phone" value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="(555) 123-4567" /></div><div className="field"><label htmlFor="lead-email">Email</label><input id="lead-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" /></div><div className="field"><label htmlFor="lead-location">Location</label><input id="lead-location" value={location} onChange={(event) => setLocation(event.target.value)} placeholder="Town or area" /></div><div className="field"><label htmlFor="lead-source">Source</label><select id="lead-source" value={source} onChange={(event) => setSource(event.target.value)}><option>Phone</option><option>Facebook</option><option>Referral</option><option>Walk-in</option><option>Other</option></select></div><div className="field full"><label htmlFor="lead-interest">Interested in</label><textarea id="lead-interest" value={interestedIn} onChange={(event) => setInterestedIn(event.target.value)} placeholder="Describe what they are looking for..." /></div><div className="field full"><label htmlFor="lead-notes">Notes</label><textarea id="lead-notes" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Add any context for the next follow-up..." /></div></div><div className="form-actions"><button type="button" className="button" onClick={() => go("leads")}>Cancel</button><button type="submit" className="button primary"><Plus size={15} /> Save Lead</button></div></form></>;
}

function NewWaitingView({ customers, onCreate, go }: { customers: Customer[]; onCreate: (entry: WaitingEntry) => void; go: (view: View) => void }) {
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [request, setRequest] = useState("");
  const [notes, setNotes] = useState("");
  const selectedCustomer = customers.find((customer) => customer.customer_name === name);
  const updateName = (value: string) => { setName(value); const customer = customers.find((item) => item.customer_name === value); if (customer && !contact) setContact(customer.phone_number || customer.email || ""); };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onCreate({ id: `local-waiting-${Date.now()}`, name, contact, request, notes, addedDate: new Date().toISOString().slice(0, 10) });
    go("waiting");
  };
  return <><div className="page-heading"><div><h1>Add to waiting list</h1><p>Capture the next customer request so you can follow up when an opening is available.</p></div><button className="button" onClick={() => go("waiting")}>Cancel</button></div><form className="card form-card" onSubmit={submit}><div className="form-grid"><div className="field"><label htmlFor="waiting-name">Customer name</label><input id="waiting-name" list="waiting-customers" value={name} onChange={(event) => updateName(event.target.value)} placeholder="Search customers..." required /><datalist id="waiting-customers">{customers.map((customer) => <option key={customer.id} value={customer.customer_name}>{customer.phone_number || customer.email || ""}</option>)}</datalist>{selectedCustomer && <div className="autocomplete-meta">{selectedCustomer.phone_number || "No phone"}{selectedCustomer.email ? ` · ${selectedCustomer.email}` : ""}{selectedCustomer.address ? ` · ${selectedCustomer.address}` : ""}</div>}</div><div className="field"><label htmlFor="waiting-contact">Phone or email</label><input id="waiting-contact" value={contact} onChange={(event) => setContact(event.target.value)} placeholder="How should we reach them?" /></div><div className="field full"><label htmlFor="waiting-request">What are they waiting for?</label><input id="waiting-request" value={request} onChange={(event) => setRequest(event.target.value)} placeholder="e.g. Hemming appointment in October" required /></div><div className="field full"><label htmlFor="waiting-notes">Notes</label><textarea id="waiting-notes" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Add any context for the next follow-up..." /></div></div><div className="form-actions"><button type="button" className="button" onClick={() => go("waiting")}>Cancel</button><button type="submit" className="button primary"><Plus size={15} /> Save to list</button></div></form></>;
}

export default function Home() {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [view, setView] = useState<View>("dashboard");
  const [data, setData] = useState<AppData>(() => loadStoredData());
  const [waitingList, setWaitingList] = useState<WaitingEntry[]>(() => loadStoredWaitingList());
  const [newJobCustomer, setNewJobCustomer] = useState<Customer | null>(null);
  const [newAppointmentCustomer, setNewAppointmentCustomer] = useState<Customer | null>(null);
  const [detail, setDetail] = useState<{ type: "customer" | "job" | "lead"; id: string } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [globalQuery, setGlobalQuery] = useState("");
  const [toastText, setToastText] = useState("");
  const [newCustomerOpen, setNewCustomerOpen] = useState(false);
  /** Where the studio's records are actually being kept right now. */
  const [cloudState, setCloudState] = useState<"checking" | "synced" | "migrating" | "offline">("checking");
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);
  const [editingJob, setEditingJob] = useState<Job | null>(null);
  const [editingLead, setEditingLead] = useState<Lead | null>(null);
  const [editingAppointment, setEditingAppointment] = useState<Appointment | null>(null);
  const [editingExpense, setEditingExpense] = useState<Expense | null>(null);
  const [editingWaiting, setEditingWaiting] = useState<WaitingEntry | null>(null);
  const [editingLifecycle, setEditingLifecycle] = useState<Lifecycle | null>(null);
  const [expenseCategories, setExpenseCategories] = useState<string[]>(() => loadStoredCategories());
  const [categoriesOpen, setCategoriesOpen] = useState(false);

  // The studio screens sit behind a sign-in. /book stays public.
  useEffect(() => {
    if (!supabase) { setAuthReady(true); return; }
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthReady(true);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((event, next) => {
      setSession(next);
      // Arriving from a "reset password" email link: ask for a new password.
      if (event === "PASSWORD_RECOVERY") { setRecoveryMode(true); setPasswordOpen(true); }
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  // The signed-in user's id, used to (re)load records once there is a session.
  const signedInUserId = session?.user?.id ?? null;

  useEffect(() => {
    // Without a session this would run as anon and always be refused.
    if (!supabase || !signedInUserId) return;
    let cancelled = false;
    void (async () => {
      const client = supabase;
      const [customers, jobs, leads, expenses, appointments, lifecycle] = await Promise.all([
        client.from("customers").select("*").order("customer_name"),
        client.from("jobs").select("*").order("delivery_date", { ascending: true }),
        client.from("leads").select("*").order("created_date", { ascending: false }),
        client.from("expenses").select("*").order("date", { ascending: false }),
        client.from("appointments").select("*").order("date", { ascending: true }),
        client.from("customer_lifecycle").select("*").order("linked_name"),
      ]);
      if (cancelled) return;
      // Any error here means the studio tables are unreachable (signed out, or
      // not a member). The local copy stays on screen rather than blanking out.
      if ([customers, jobs, leads, expenses, appointments, lifecycle].some((result) => result.error)) {
        setCloudState("offline");
        return;
      }
      const next = { customers: (customers.data || []) as Customer[], jobs: (jobs.data || []) as Job[], leads: (leads.data || []) as Lead[], expenses: (expenses.data || []) as Expense[], appointments: (appointments.data || []) as Appointment[], lifecycle: (lifecycle.data || []) as Lifecycle[] };
      const remoteTotal = Object.values(next).reduce((sum, rows) => sum + rows.length, 0);
      if (remoteTotal > 0) {
        // Anything this browser still holds that the database does not was lost
        // rather than deliberately removed, so merge it back and re-upload it.
        if (hasStoredData()) {
          const { data: merged, additions } = mergeLocalOnly(next, loadStoredData());
          setData(merged);
          if (additions.length > 0) {
            console.log("[stitchflow] restoring records missing from the database:", additions.map((a) => `${a.table}=${a.rows.length}`).join(" "));
            await Promise.all(additions.map((a) => saveRows(client, a.table, a.rows.map((row) => nullTypedBlanks(row)), "upsert", a.table)));
          }
        } else {
          setData(next);
        }
        setCloudState("synced");
        return;
      }
      // The studio tables are empty. Push this browser's records up once so the
      // history stops living only here -- but only if this device has actually
      // saved a workspace, otherwise it would upload the demo seed records.
      if (!hasStoredData()) { setCloudState("synced"); return; }
      const local = loadStoredData();
      const localTotal = Object.values(local).reduce((sum, rows) => sum + rows.length, 0);
      if (localTotal === 0) { setCloudState("synced"); return; }
      setCloudState("migrating");
      const stamp = (rows: Record<string, unknown>[]) => rows.map((row) => nullTypedBlanks({ created_date: new Date().toISOString(), ...row }));
      const results = await Promise.all([
        saveRows(client, "customers", stamp(local.customers as unknown as Row[]), "upsert", "customer"),
        saveRows(client, "jobs", stamp(local.jobs as unknown as Row[]), "upsert", "job"),
        saveRows(client, "leads", stamp(local.leads as unknown as Row[]), "upsert", "lead"),
        saveRows(client, "expenses", stamp(local.expenses as unknown as Row[]), "upsert", "expense"),
        saveRows(client, "appointments", stamp(local.appointments as unknown as Row[]), "upsert", "appointment"),
        saveRows(client, "customer_lifecycle", stamp(local.lifecycle as unknown as Row[]), "upsert", "lifecycle record"),
      ]);
      if (cancelled) return;
      const failed = results.reduce((sum, result) => sum + result.failed, 0);
      setCloudState(failed > 0 ? "offline" : "synced");
    })();
    return () => { cancelled = true; };
  }, [signedInUserId]);

  useEffect(() => {
    try {
      window.localStorage.setItem("stitchflow-data", JSON.stringify(data));
      window.localStorage.setItem("stitchflow-waiting-list", JSON.stringify(waitingList));
      window.localStorage.setItem("stitchflow-expense-categories", JSON.stringify(expenseCategories));
    } catch {
      // Storage is optional; the in-memory workspace still remains usable.
    }
  }, [data, waitingList, expenseCategories]);

  const go = (next: View) => { setView(next); setDetail(null); setNewJobCustomer(null); setNewAppointmentCustomer(null); setSearchOpen(false); setMobileMenuOpen(false); setGlobalQuery(""); window.scrollTo({ top: 0, behavior: "smooth" }); };
  const openCustomer = (customer: Customer) => { setView("customers"); setDetail({ type: "customer", id: customer.id }); window.scrollTo({ top: 0, behavior: "smooth" }); };
  const openJob = (job: Job) => { setView("jobs"); setDetail({ type: "job", id: job.id }); window.scrollTo({ top: 0, behavior: "smooth" }); };
  const openLead = (lead: Lead) => { setView("leads"); setDetail({ type: "lead", id: lead.id }); window.scrollTo({ top: 0, behavior: "smooth" }); };
  const openNewJobForCustomer = (customer: Customer) => { setNewJobCustomer(customer); setDetail(null); setView("new-job"); window.scrollTo({ top: 0, behavior: "smooth" }); };
  const openNewAppointmentForCustomer = (customer: Customer) => { setNewAppointmentCustomer(customer); setDetail(null); setView("new-appointment"); window.scrollTo({ top: 0, behavior: "smooth" }); };
  const closeDetail = () => { setDetail(null); window.scrollTo({ top: 0, behavior: "smooth" }); };
  const toast = (message: string) => { setToastText(message); window.setTimeout(() => setToastText(""), 2800); };
  const saveNew = (table: string, row: Row, label: string) => { if (supabase) void saveRows(supabase, table, [nullTypedBlanks(row)], "insert", label); };
  const createJob = (job: Job) => {
    setData((current) => ({ ...current, jobs: [job, ...current.jobs] }));
    toast("Job saved to your studio workspace.");
    if (!supabase) return;
    const client = supabase;
    // Send no number, so the database assigns one from its own sequence and a
    // duplicate is impossible even with two tabs open. Then adopt what it gave.
    void saveRows(client, "jobs", [nullTypedBlanks({ ...job, job_id: null })], "insert", "job").then(async (result) => {
      if (result.saved === 0) return;
      const { data } = await client.from("jobs").select("job_id").eq("id", job.id).maybeSingle();
      if (data?.job_id) {
        setData((current) => ({ ...current, jobs: current.jobs.map((item) => (item.id === job.id ? { ...item, job_id: (data as { job_id: string }).job_id } : item)) }));
      }
    });
  };
  const createExpense = (expense: Expense) => { setData((current) => ({ ...current, expenses: [expense, ...current.expenses] })); toast("Expense added to your studio finances."); saveNew("expenses", expense, "expense"); };
  const createWaitingEntry = (entry: WaitingEntry) => { setWaitingList((current) => [entry, ...current]); toast("Customer added to the waiting list."); };
  const createAppointment = (appointment: Appointment) => { setData((current) => ({ ...current, appointments: [appointment, ...current.appointments] })); toast("Appointment added to your studio calendar."); saveNew("appointments", appointment, "appointment"); };
  const createCustomer = (customer: Customer) => { setData((current) => ({ ...current, customers: [customer, ...current.customers] })); toast("Customer added to your book."); saveNew("customers", customer, "customer"); };
  const createLead = (lead: Lead) => { setData((current) => ({ ...current, leads: [lead, ...current.leads] })); toast("Lead added to your pipeline."); saveNew("leads", lead, "lead"); };
  const completeAppointment = (appointment: Appointment) => { const completed = { ...appointment, status: "Completed" }; setData((current) => ({ ...current, appointments: current.appointments.map((item) => item.id === appointment.id ? completed : item) })); toast("Appointment marked completed."); if (supabase) void saveUpdate(supabase, "appointments", { status: "Completed" }, "id", appointment.id, "appointment"); };
  const updateCustomer = (updated: Customer) => {
    const previous = data.customers.find((item) => item.id === updated.id);
    setData((current) => ({ ...current, customers: current.customers.map((item) => item.id === updated.id ? updated : item), jobs: previous ? current.jobs.map((job) => (jobBelongsTo(job, previous) ? { ...job, customer_name: updated.customer_name, phone_number: updated.phone_number, email: updated.email } : job)) : current.jobs }));
    if (supabase) {
      void saveUpdate(supabase, "customers", { ...updated, updated_date: new Date().toISOString() }, "id", updated.id, "customer");
      void saveUpdate(supabase, "jobs", { customer_name: updated.customer_name, phone_number: updated.phone_number, updated_date: new Date().toISOString() }, "customer_id", updated.id, "job");
    }
    setEditingCustomer(null);
    toast("Customer updated.");
  };
  const updateJob = (updated: Job) => {
    setData((current) => ({ ...current, jobs: current.jobs.map((item) => item.id === updated.id ? updated : item) }));
    if (supabase) {
      const { email: _email, ...jobFields } = updated;
      void saveUpdate(supabase, "jobs", { ...jobFields, updated_date: new Date().toISOString() }, "id", updated.id, "job");
    }
    setEditingJob(null);
    toast("Job updated.");
  };
  const updateLead = (updated: Lead) => {
    setData((current) => ({ ...current, leads: current.leads.map((item) => item.id === updated.id ? updated : item) }));
    if (supabase) void saveUpdate(supabase, "leads", { ...updated, updated_date: new Date().toISOString() }, "id", updated.id, "lead");
    setEditingLead(null);
    toast("Lead updated.");
  };
  const updateAppointment = (updated: Appointment) => {
    setData((current) => ({ ...current, appointments: current.appointments.map((item) => item.id === updated.id ? updated : item) }));
    if (supabase) void saveUpdate(supabase, "appointments", { ...updated, updated_date: new Date().toISOString() }, "id", updated.id, "appointment");
    setEditingAppointment(null);
    toast("Appointment updated.");
  };
  const updateExpense = (updated: Expense) => {
    setData((current) => ({ ...current, expenses: current.expenses.map((item) => item.id === updated.id ? updated : item) }));
    if (supabase) void saveUpdate(supabase, "expenses", { ...updated, updated_date: new Date().toISOString() }, "id", updated.id, "expense");
    setEditingExpense(null);
    toast("Expense updated.");
  };
  const updateWaiting = (updated: WaitingEntry) => {
    setWaitingList((current) => current.map((item) => item.id === updated.id ? updated : item));
    setEditingWaiting(null);
    toast("Waiting list entry updated.");
  };
  const updateLifecycle = (updated: Lifecycle) => {
    setData((current) => ({ ...current, lifecycle: current.lifecycle.map((item) => item.id === updated.id ? updated : item) }));
    if (supabase) void saveUpdate(supabase, "customer_lifecycle", { ...updated, updated_date: new Date().toISOString() }, "id", updated.id, "lifecycle record");
    setEditingLifecycle(null);
    toast("Lifecycle updated.");
  };

  const searchResults = useMemo(() => {
    const query = globalQuery.toLowerCase();
    if (!query) return [] as { type: string; title: string; detail: string; view: View; id: string }[];
    return [
      ...data.customers.filter((item) => `${item.customer_name} ${item.phone_number || ""}`.toLowerCase().includes(query)).slice(0, 4).map((item) => ({ type: "Customer", title: item.customer_name, detail: item.phone_number || "Customer", view: "customers" as View, id: item.id })),
      ...data.jobs.filter((item) => `${item.customer_name} ${item.job_details || ""}`.toLowerCase().includes(query)).slice(0, 4).map((item) => ({ type: "Job", title: item.customer_name, detail: item.job_details || "Job", view: "jobs" as View, id: item.id })),
      ...data.leads.filter((item) => `${item.name} ${item.interested_in || ""}`.toLowerCase().includes(query)).slice(0, 4).map((item) => ({ type: "Lead", title: item.name, detail: item.interested_in || "Lead", view: "leads" as View, id: item.id })),
    ].slice(0, 8);
  }, [data, globalQuery]);

  const title = navItems.find((item) => item.key === view)?.label || (view === "new-job" ? "Add Job" : view === "new-expense" ? "Add Expense" : view === "new-waiting" ? "Add to waiting list" : view === "new-appointment" ? "New Appointment" : view === "new-lead" ? "New Lead" : "Dashboard");
  const selectedCustomer = detail?.type === "customer" ? data.customers.find((item) => item.id === detail.id) : undefined;
  const selectedJob = detail?.type === "job" ? data.jobs.find((item) => item.id === detail.id) : undefined;
  const selectedLead = detail?.type === "lead" ? data.leads.find((item) => item.id === detail.id) : undefined;

  if (supabase && !authReady) return <div className="auth-boot">Loading studio…</div>;
  if (supabase && !session) return <SignIn />;

  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><div className="brand-mark"><Scissors size={18} /></div><div><div className="brand-name">Stitch &amp; Thread</div><div className="brand-subtitle">Studio Manager</div></div></div><button className="search-box" style={{ width: "100%" }} onClick={() => setSearchOpen(true)}><Search size={16} /><span style={{ fontSize: 14, color: "#a49e97" }}>Search...</span></button><nav className="nav">{navItems.map(({ key, label, icon: Icon }) => <button key={key} className={`nav-item ${view === key ? "active" : ""}`} onClick={() => go(key)}><Icon size={17} />{label}</button>)}<button className={`nav-item accent ${view === "new-job" ? "active" : ""}`} onClick={() => go("new-job")}><Plus size={17} />Add Job</button></nav><div className="studio-name">Rachel&apos;s Seamstress Studio</div>{supabase && <div className={`sync-badge ${cloudState}`} role="status">{cloudState === "synced" ? "Saved to the studio database" : cloudState === "migrating" ? "Copying this device's records to the database…" : cloudState === "offline" ? "Saved on this device only" : "Checking your records…"}</div>}{supabase && session && <div className="auth-account"><button className="nav-item auth-signout" onClick={() => void supabase?.auth.signOut()}>Sign out{session.user?.email ? ` · ${session.user.email}` : ""}</button><button className="nav-item auth-signout" onClick={() => { setRecoveryMode(false); setPasswordOpen(true); }}>Change password</button></div>}</aside>
    <main className="main-shell"><div className="mobile-topbar"><button className="icon-button" aria-label={mobileMenuOpen ? "Close navigation menu" : "Open navigation menu"} aria-expanded={mobileMenuOpen} onClick={() => setMobileMenuOpen((open) => !open)}>{mobileMenuOpen ? <X size={20} /> : <Menu size={20} />}</button><div className="brand-name">Stitch &amp; Thread</div><button className="icon-button" aria-label="Search studio" onClick={() => { setMobileMenuOpen(false); setSearchOpen(true); }}><Search size={18} /></button></div>{mobileMenuOpen && <div className="mobile-menu-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setMobileMenuOpen(false)}><div className="mobile-menu-panel" role="dialog" aria-modal="true" aria-label="Navigation menu"><div className="mobile-menu-heading"><div><div className="brand-name">Stitch &amp; Thread</div><div className="brand-subtitle">Studio Manager</div></div><button className="icon-button" aria-label="Close navigation menu" onClick={() => setMobileMenuOpen(false)}><X size={18} /></button></div><nav className="mobile-menu-nav">{navItems.map(({ key, label, icon: Icon }) => <button key={key} className={`nav-item ${view === key ? "active" : ""}`} onClick={() => go(key)}><Icon size={17} />{label}</button>)}<button className={`nav-item accent ${view === "new-job" ? "active" : ""}`} onClick={() => go("new-job")}><Plus size={17} />Add Job</button></nav></div></div>}<div className="content" aria-label={`${title} page`}>
      {view === "dashboard" && <DashboardView data={data} go={go} onSelectJob={openJob} />}
      {view === "jobs" && selectedJob ? <JobDetailView job={selectedJob} data={data} onBack={closeDetail} onSelectJob={openJob} onEdit={setEditingJob} /> : null}
      {view === "jobs" && (!detail || detail.type !== "job") && <JobsView data={data} go={go} toast={toast} onSelect={openJob} onEdit={setEditingJob} />}
      {view === "customers" && selectedCustomer ? <CustomerDetailView customer={selectedCustomer} data={data} onBack={closeDetail} onSelectJob={openJob} onNewJob={openNewJobForCustomer} onAddAppointment={openNewAppointmentForCustomer} onEdit={setEditingCustomer} /> : null}
      {view === "customers" && (!detail || detail.type !== "customer") && <CustomersView data={data} go={go} onSelect={openCustomer} onEdit={setEditingCustomer} onNew={() => setNewCustomerOpen(true)} />}
      {view === "leads" && selectedLead ? <LeadDetailView lead={selectedLead} onBack={closeDetail} onEdit={setEditingLead} /> : null}
      {view === "leads" && (!detail || detail.type !== "lead") && <LeadsView data={data} go={go} onSelect={openLead} onEdit={setEditingLead} />}
      {view === "bookings" && <BookingsView />}
      {view === "appointments" && <AppointmentsView data={data} go={go} onComplete={completeAppointment} onEdit={setEditingAppointment} />}
      {view === "finances" && <FinancesView data={data} go={go} onEditExpense={setEditingExpense} toast={toast} onManageCategories={() => setCategoriesOpen(true)} />}
      {view === "waiting" && <WaitingView entries={waitingList} customers={data.customers} go={go} onEdit={setEditingWaiting} />}
      {view === "team" && <TeamView />}
      {view === "lifecycle" && <LifecycleView data={data} onEdit={setEditingLifecycle} />}
      {view === "new-job" && <NewJobView data={data} onCreate={createJob} go={go} initialCustomer={newJobCustomer} />}
      {view === "new-expense" && <NewExpenseView categories={expenseCategories} onCreate={createExpense} go={go} />}
      {view === "new-waiting" && <NewWaitingView customers={data.customers} onCreate={createWaitingEntry} go={go} />}
      {view === "new-appointment" && <NewAppointmentView data={data} onCreate={createAppointment} go={go} initialCustomer={newAppointmentCustomer} />}
      {view === "new-lead" && <NewLeadView data={data} onCreate={createLead} go={go} />}
    </div></main>
    {passwordOpen && session?.user?.email && <ChangePasswordModal email={session.user.email} recovery={recoveryMode} onClose={() => { setPasswordOpen(false); setRecoveryMode(false); }} />}
    {newCustomerOpen && <NewCustomerModal onClose={() => setNewCustomerOpen(false)} onSave={(customer) => { createCustomer(customer); setNewCustomerOpen(false); }} />}
    {editingCustomer && <EditCustomerModal customer={editingCustomer} onClose={() => setEditingCustomer(null)} onSave={updateCustomer} />}
    {editingJob && <EditJobModal job={editingJob} customers={data.customers} onClose={() => setEditingJob(null)} onSave={updateJob} />}
    {editingLead && <EditLeadModal lead={editingLead} onClose={() => setEditingLead(null)} onSave={updateLead} />}
    {editingAppointment && <EditAppointmentModal appointment={editingAppointment} customers={data.customers} onClose={() => setEditingAppointment(null)} onSave={updateAppointment} />}
    {editingExpense && <EditExpenseModal expense={editingExpense} categories={expenseCategories} onClose={() => setEditingExpense(null)} onSave={updateExpense} />}
    {categoriesOpen && <ManageCategoriesModal categories={expenseCategories} expenses={data.expenses} onChange={setExpenseCategories} onClose={() => setCategoriesOpen(false)} />}
    {editingWaiting && <EditWaitingModal entry={editingWaiting} customers={data.customers} onClose={() => setEditingWaiting(null)} onSave={updateWaiting} />}
    {editingLifecycle && <EditLifecycleModal record={editingLifecycle} onClose={() => setEditingLifecycle(null)} onSave={updateLifecycle} />}
    {searchOpen && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setSearchOpen(false)}><div className="modal" role="dialog" aria-modal="true" aria-label="Search your studio"><div className="modal-heading"><h2>Search your studio</h2><button className="icon-button" aria-label="Close search" onClick={() => setSearchOpen(false)}><X size={18} /></button></div><SearchBox value={globalQuery} onChange={setGlobalQuery} placeholder="Search customers, jobs, or leads..." />{globalQuery && <div className="search-results" style={{ marginTop: 12 }}>{searchResults.length === 0 ? <div className="empty">No matches found.</div> : searchResults.map((result, index) => <button className="search-result" key={`${result.type}-${result.title}-${index}`} onClick={() => { setSearchOpen(false); setGlobalQuery(""); if (result.type === "Customer") openCustomer(data.customers.find((item) => item.id === result.id) || data.customers[0]); else if (result.type === "Job") openJob(data.jobs.find((item) => item.id === result.id) || data.jobs[0]); else openLead(data.leads.find((item) => item.id === result.id) || data.leads[0]); }}><div className="avatar">{initials(result.title)}</div><div><div className="row-title">{result.title}</div><small>{result.type} · {result.detail}</small></div></button>)}</div>}</div></div>}
    {toastText && <div className="toast" role="status">{toastText}</div>}
  </div>;
}
