"use client";

import { FormEvent, ReactNode, useEffect, useMemo, useState } from "react";
import {
  AlarmClock,
  ArrowUpRight,
  ArrowLeft,
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
  UserRound,
  UsersRound,
  WalletCards,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { AppData, Customer, Expense, Job, Lead, Lifecycle, Appointment, fullDate, initials, money, seedData, shortDate, statusTone } from "@/lib/data";
import { supabase } from "@/lib/supabase";

type View = "dashboard" | "jobs" | "customers" | "leads" | "appointments" | "finances" | "waiting" | "team" | "lifecycle" | "new-job" | "new-expense" | "new-waiting" | "new-appointment";
type WaitingEntry = { id: string; name: string; contact?: string; request: string; notes?: string; addedDate: string };

type NavItem = { key: View; label: string; icon: LucideIcon };

const navItems: NavItem[] = [
  { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { key: "jobs", label: "Jobs", icon: ClipboardList },
  { key: "customers", label: "Customers", icon: UsersRound },
  { key: "leads", label: "Leads", icon: UserRound },
  { key: "appointments", label: "Appointments", icon: CalendarDays },
  { key: "finances", label: "Finances", icon: WalletCards },
  { key: "waiting", label: "Waiting List", icon: ListFilter },
  { key: "team", label: "Team", icon: UsersRound },
  { key: "lifecycle", label: "Lifecycle", icon: Sparkles },
];

const steps = ["New inquiry", "Measurements", "Quote", "In progress", "Ready", "Delivered"];

const cloneData = (): AppData => JSON.parse(JSON.stringify(seedData)) as AppData;

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

const loadStoredWaitingList = (): WaitingEntry[] => {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem("stitchflow-waiting-list");
    return raw ? JSON.parse(raw) as WaitingEntry[] : [];
  } catch {
    return [];
  }
};

const numeric = (value: number | string | undefined) => Number(value || 0);

const isClosed = (status?: string) => ["paid", "delivered", "cancelled"].includes((status || "").toLowerCase());

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
  return <div className="modal-backdrop document-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><form className="document-modal invoice-modal" onSubmit={download} role="dialog" aria-modal="true" aria-label="Edit invoice"><div className="modal-heading"><h2>Edit Invoice</h2><button type="button" className="icon-button" aria-label="Close invoice" onClick={onClose}><X size={18} /></button></div><div className="document-modal-body"><div className="field"><label htmlFor="invoice-business">Business Name</label><input id="invoice-business" value={draft.businessName} onChange={(event) => update("businessName", event.target.value)} /></div><div className="field"><label htmlFor="invoice-client">Client Name</label><input id="invoice-client" value={draft.clientName} onChange={(event) => update("clientName", event.target.value)} required /></div><div className="field"><label htmlFor="invoice-phone">Phone</label><input id="invoice-phone" value={draft.phone} onChange={(event) => update("phone", event.target.value)} /></div><div className="field"><label htmlFor="invoice-description">Description of Work</label><textarea id="invoice-description" value={draft.description} onChange={(event) => update("description", event.target.value)} required /></div><div className="field"><label htmlFor="invoice-due">Due Date</label><input id="invoice-due" type="date" value={draft.dueDate} onChange={(event) => update("dueDate", event.target.value)} /></div><div className="modal-three"><div className="field"><label htmlFor="invoice-amount">Amount ($)</label><input id="invoice-amount" type="number" min="0" step="0.01" value={draft.amount} onChange={(event) => update("amount", event.target.value)} /></div><div className="field"><label htmlFor="invoice-deposit">Deposit ($)</label><input id="invoice-deposit" type="number" min="0" step="0.01" value={draft.deposit} onChange={(event) => update("deposit", event.target.value)} /></div><div className="field"><label htmlFor="invoice-balance">Balance ($)</label><input id="invoice-balance" type="number" min="0" step="0.01" value={draft.balance} onChange={(event) => update("balance", event.target.value)} /></div></div><div className="field"><label htmlFor="invoice-payment">Payment Method</label><select id="invoice-payment" value={draft.paymentMethod} onChange={(event) => update("paymentMethod", event.target.value)}><option>Cash</option><option>Card</option><option>Check</option><option>Venmo</option><option>Other</option></select></div><div className="field"><label htmlFor="invoice-notes">Notes</label><textarea id="invoice-notes" value={draft.notes} onChange={(event) => update("notes", event.target.value)} placeholder="Add any extra invoice notes..." /></div></div><div className="document-modal-footer"><button type="button" className="button" onClick={onClose}>Cancel</button><button type="submit" className="button primary">Download PDF</button></div></form></div>;
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

function EditJobModal({ job, customers, onClose, onSave }: { job: Job; customers: Customer[]; onClose: () => void; onSave: (job: Job) => void }) {
  const [draft, setDraft] = useState<Job>({ ...job });
  const update = (key: keyof Job, value: string | number) => setDraft((current) => ({ ...current, [key]: value }));
  const updateCustomer = (value: string) => {
    const customer = customers.find((item) => item.customer_name === value);
    setDraft((current) => ({ ...current, customer_name: value, customer_id: customer?.id || current.customer_id, phone_number: customer?.phone_number || current.phone_number, email: customer?.email || current.email }));
  };
  const submit = (event: FormEvent) => { event.preventDefault(); onSave(draft); };
  return <EditModalShell title="Edit Job" ariaLabel="edit job" onClose={onClose} onSubmit={submit}><div className="modal-two"><div className="field"><label htmlFor="edit-job-customer">Customer</label><input id="edit-job-customer" list="edit-job-customers" value={draft.customer_name} onChange={(event) => updateCustomer(event.target.value)} required /><datalist id="edit-job-customers">{customers.map((customer) => <option key={customer.id} value={customer.customer_name}>{customer.phone_number || customer.email || ""}</option>)}</datalist></div><div className="field"><label htmlFor="edit-job-status">Status</label><select id="edit-job-status" value={statusLabel(draft.status)} onChange={(event) => update("status", event.target.value)}><option>New Job</option><option>In Progress</option><option>Ready for Pickup</option><option>Delivered</option><option>Paid</option><option>Cancelled</option></select></div></div><div className="field"><label htmlFor="edit-job-details">Job details</label><textarea id="edit-job-details" value={draft.job_details || ""} onChange={(event) => update("job_details", event.target.value)} placeholder="Describe the alterations or project..." required /></div><div className="modal-three"><div className="field"><label htmlFor="edit-job-amount">Amount ($)</label><input id="edit-job-amount" type="number" min="0" step="0.01" value={draft.amount_to_charge ?? ""} onChange={(event) => update("amount_to_charge", event.target.value)} /></div><div className="field"><label htmlFor="edit-job-deposit">Deposit ($)</label><input id="edit-job-deposit" type="number" min="0" step="0.01" value={draft.deposit_paid ?? ""} onChange={(event) => update("deposit_paid", event.target.value)} /></div><div className="field"><label htmlFor="edit-job-balance">Balance ($)</label><input id="edit-job-balance" type="number" min="0" step="0.01" value={draft.balance_due ?? ""} onChange={(event) => update("balance_due", event.target.value)} /></div></div><div className="modal-two"><div className="field"><label htmlFor="edit-job-delivery">Delivery date</label><input id="edit-job-delivery" type="date" value={draft.delivery_date || ""} onChange={(event) => update("delivery_date", event.target.value)} /></div><div className="field"><label htmlFor="edit-job-payment">Payment method</label><select id="edit-job-payment" value={draft.payment_method || "Cash"} onChange={(event) => update("payment_method", event.target.value)}><option>Cash</option><option>Card</option><option>Check</option><option>Venmo</option><option>Other</option></select></div></div><div className="field"><label htmlFor="edit-job-measurements">Measurement notes</label><textarea id="edit-job-measurements" value={draft.measurement_notes || ""} onChange={(event) => update("measurement_notes", event.target.value)} placeholder="Add fitting measurements or preferences..." /></div><div className="field"><label htmlFor="edit-job-notes">Notes</label><textarea id="edit-job-notes" value={draft.notes || ""} onChange={(event) => update("notes", event.target.value)} placeholder="Add job notes..." /></div></EditModalShell>;
}

function EditLeadModal({ lead, onClose, onSave }: { lead: Lead; onClose: () => void; onSave: (lead: Lead) => void }) {
  const [draft, setDraft] = useState<Lead>({ ...lead });
  const update = (key: keyof Lead, value: string) => setDraft((current) => ({ ...current, [key]: value }));
  const submit = (event: FormEvent) => { event.preventDefault(); onSave(draft); };
  return <EditModalShell title="Edit Lead" ariaLabel="edit lead" onClose={onClose} onSubmit={submit}><div className="modal-two"><div className="field"><label htmlFor="edit-lead-name">Name</label><input id="edit-lead-name" value={draft.name} onChange={(event) => update("name", event.target.value)} required /></div><div className="field"><label htmlFor="edit-lead-status">Status</label><select id="edit-lead-status" value={draft.status || "New"} onChange={(event) => update("status", event.target.value)}><option>New</option><option>Contacted</option><option>Qualified</option><option>Converted</option><option>Lost</option></select></div></div><div className="modal-two"><div className="field"><label htmlFor="edit-lead-phone">Phone</label><input id="edit-lead-phone" value={draft.phone_number || ""} onChange={(event) => update("phone_number", event.target.value)} /></div><div className="field"><label htmlFor="edit-lead-email">Email</label><input id="edit-lead-email" type="email" value={draft.email || ""} onChange={(event) => update("email", event.target.value)} /></div></div><div className="modal-two"><div className="field"><label htmlFor="edit-lead-location">Location</label><input id="edit-lead-location" value={draft.location || ""} onChange={(event) => update("location", event.target.value)} /></div><div className="field"><label htmlFor="edit-lead-source">Source</label><select id="edit-lead-source" value={draft.source || "Other"} onChange={(event) => update("source", event.target.value)}><option>Phone</option><option>Facebook</option><option>Referral</option><option>Walk-in</option><option>Other</option></select></div></div><div className="field"><label htmlFor="edit-lead-interest">Interested in</label><textarea id="edit-lead-interest" value={draft.interested_in || ""} onChange={(event) => update("interested_in", event.target.value)} placeholder="Describe what they are looking for..." /></div><div className="field"><label htmlFor="edit-lead-notes">Notes</label><textarea id="edit-lead-notes" value={draft.notes || ""} onChange={(event) => update("notes", event.target.value)} placeholder="Add follow-up notes..." /></div></EditModalShell>;
}

function EditAppointmentModal({ appointment, customers, onClose, onSave }: { appointment: Appointment; customers: Customer[]; onClose: () => void; onSave: (appointment: Appointment) => void }) {
  const [draft, setDraft] = useState<Appointment>({ ...appointment });
  const update = (key: keyof Appointment, value: string) => setDraft((current) => ({ ...current, [key]: value }));
  const updateCustomer = (value: string) => { const customer = customers.find((item) => item.customer_name === value); setDraft((current) => ({ ...current, linked_name: value, linked_id: customer?.id || current.linked_id, linked_type: customer ? "Customer" : current.linked_type })); };
  const submit = (event: FormEvent) => { event.preventDefault(); onSave(draft); };
  return <EditModalShell title="Edit Appointment" ariaLabel="edit appointment" onClose={onClose} onSubmit={submit}><div className="field"><label htmlFor="edit-appointment-customer">Customer</label><input id="edit-appointment-customer" list="edit-appointment-customers" value={draft.linked_name || ""} onChange={(event) => updateCustomer(event.target.value)} placeholder="Search customers..." /><datalist id="edit-appointment-customers">{customers.map((customer) => <option key={customer.id} value={customer.customer_name}>{customer.phone_number || customer.email || ""}</option>)}</datalist></div><div className="field"><label htmlFor="edit-appointment-title">Appointment type</label><input id="edit-appointment-title" value={draft.title || ""} onChange={(event) => update("title", event.target.value)} required /></div><div className="modal-three"><div className="field"><label htmlFor="edit-appointment-date">Date</label><input id="edit-appointment-date" type="date" value={draft.date || ""} onChange={(event) => update("date", event.target.value)} required /></div><div className="field"><label htmlFor="edit-appointment-time">Time</label><input id="edit-appointment-time" type="time" value={draft.time || ""} onChange={(event) => update("time", event.target.value)} /></div><div className="field"><label htmlFor="edit-appointment-status">Status</label><select id="edit-appointment-status" value={draft.status || "Scheduled"} onChange={(event) => update("status", event.target.value)}><option>Scheduled</option><option>Completed</option><option>Cancelled</option></select></div></div><div className="field"><label htmlFor="edit-appointment-notes">Notes</label><textarea id="edit-appointment-notes" value={draft.notes || ""} onChange={(event) => update("notes", event.target.value)} placeholder="Add appointment details..." /></div></EditModalShell>;
}

function EditExpenseModal({ expense, onClose, onSave }: { expense: Expense; onClose: () => void; onSave: (expense: Expense) => void }) {
  const [draft, setDraft] = useState<Expense>({ ...expense });
  const update = (key: keyof Expense, value: string | number) => setDraft((current) => ({ ...current, [key]: value }));
  const submit = (event: FormEvent) => { event.preventDefault(); onSave(draft); };
  return <EditModalShell title="Edit Expense" ariaLabel="edit expense" onClose={onClose} onSubmit={submit}><div className="field"><label htmlFor="edit-expense-note">Description</label><input id="edit-expense-note" value={draft.note || ""} onChange={(event) => update("note", event.target.value)} required /></div><div className="modal-two"><div className="field"><label htmlFor="edit-expense-amount">Amount</label><input id="edit-expense-amount" type="number" min="0.01" step="0.01" value={draft.amount ?? ""} onChange={(event) => update("amount", event.target.value)} required /></div><div className="field"><label htmlFor="edit-expense-date">Date</label><input id="edit-expense-date" type="date" value={draft.date || ""} onChange={(event) => update("date", event.target.value)} required /></div></div><div className="modal-two"><div className="field"><label htmlFor="edit-expense-category">Category</label><select id="edit-expense-category" value={draft.category || "Other"} onChange={(event) => update("category", event.target.value)}><option>Supplies</option><option>Fabric</option><option>Equipment</option><option>Rent &amp; utilities</option><option>Marketing</option><option>Other</option></select></div><div className="field"><label htmlFor="edit-expense-job">Job ID</label><input id="edit-expense-job" value={draft.job_id || ""} onChange={(event) => update("job_id", event.target.value)} placeholder="Optional job ID" /></div></div></EditModalShell>;
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
  const customerFor = (job: Job) => data.customers.find((customer) => customer.id === job.customer_id || customer.customer_name === job.customer_name);
  return <><div className="page-heading"><div><h1>Jobs</h1><p>Track every alteration from intake to pickup.</p></div><div className="page-heading-actions"><button className="button primary" onClick={() => go("new-job")}><Plus size={15} /> New Job</button></div></div><div className="toolbar"><SearchBox value={query} onChange={setQuery} placeholder="Search by name or job details..." /><div className="filter-strip">{filters.map((item) => <button key={item} className={`filter-button ${filter === item ? "active" : ""}`} onClick={() => setFilter(item)}>{item}</button>)}</div></div><div className="stack">{jobs.length === 0 ? <div className="empty">No jobs match your search.</div> : jobs.map((job) => <JobRow key={job.id} job={job} onSelect={onSelect} onEdit={onEdit} onSendQuote={(selected) => setQuoteJob(selected)} onExportInvoice={(selected) => setInvoiceJob(selected)} />)}</div>{quoteJob && <QuoteModal job={quoteJob} customer={customerFor(quoteJob)} onClose={() => setQuoteJob(null)} />}{invoiceJob && <InvoiceModal job={invoiceJob} customer={customerFor(invoiceJob)} onClose={() => setInvoiceJob(null)} />}</>;
}

function CustomersView({ data, go, onSelect, onEdit }: { data: AppData; go: (view: View) => void; onSelect: (customer: Customer) => void; onEdit: (customer: Customer) => void }) {
  const [query, setQuery] = useState("");
  const customers = data.customers.filter((customer) => `${customer.customer_name} ${customer.phone_number || ""} ${customer.email || ""} ${customer.address || ""}`.toLowerCase().includes(query.toLowerCase()));
  return <><div className="page-heading"><div><h1>Customers</h1><p>Your customer book, ready for the next fitting.</p></div><button className="button primary" onClick={() => go("new-job")}><Plus size={15} /> New</button></div><div className="toolbar"><SearchBox value={query} onChange={setQuery} placeholder="Search customers..." /></div><div className="stack">{customers.length === 0 ? <div className="empty">No customers match your search.</div> : customers.map((customer) => <div key={customer.id} className="customer-row clickable" role="button" tabIndex={0} onClick={() => onSelect(customer)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(customer); } }}><div className="avatar">{initials(customer.customer_name)}</div><div className="customer-row-main"><div className="row-title">{customer.customer_name}</div><div className="row-meta">{customer.phone_number || "No phone"}{customer.address ? ` · ${customer.address}` : ""}</div></div><span className="badge info">{customer.source || "Customer"}</span><button className="button small row-edit-button" aria-label={`Edit ${customer.customer_name}`} onClick={(event) => { event.stopPropagation(); onEdit(customer); }}><Pencil size={13} /> Edit</button><ChevronRight size={16} className="muted" /></div>)}</div></>;
}

function LeadsView({ data, onSelect, onEdit }: { data: AppData; onSelect: (lead: Lead) => void; onEdit: (lead: Lead) => void }) {
  const [query, setQuery] = useState("");
  const leads = data.leads.filter((lead) => `${lead.name} ${lead.interested_in || ""} ${lead.source || ""}`.toLowerCase().includes(query.toLowerCase()));
  return <><div className="page-heading"><div><h1>Leads</h1><p>Keep warm inquiries moving toward their first fitting.</p></div><button className="button primary"><Plus size={15} /> New Lead</button></div><div className="toolbar"><SearchBox value={query} onChange={setQuery} placeholder="Search leads..." /></div><div className="stack">{leads.length === 0 ? <div className="empty">No leads match your search.</div> : leads.map((lead) => <div key={lead.id} className="lead-row clickable" role="button" tabIndex={0} onClick={() => onSelect(lead)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(lead); } }}><div className="avatar blue">{initials(lead.name)}</div><div className="lead-row-main"><div className="row-title">{lead.name}</div><div className="row-description">{lead.interested_in || "No project details yet."}</div><div className="row-meta">{lead.phone_number || lead.email || "No contact details"}</div></div><span className={`badge ${statusTone(lead.status)}`}>{lead.status || "New"}</span><button className="button small row-edit-button" aria-label={`Edit ${lead.name}`} onClick={(event) => { event.stopPropagation(); onEdit(lead); }}><Pencil size={13} /> Edit</button></div>)}</div></>;
}

function DetailBack({ label, onBack }: { label: string; onBack: () => void }) {
  return <button className="button ghost back-button" onClick={onBack}><ArrowLeft size={15} /> Back to {label}</button>;
}

function CustomerDetailView({ customer, data, onBack, onSelectJob, onNewJob, onAddAppointment, onEdit }: { customer: Customer; data: AppData; onBack: () => void; onSelectJob: (job: Job) => void; onNewJob: (customer: Customer) => void; onAddAppointment: (customer: Customer) => void; onEdit: (customer: Customer) => void }) {
  const jobs = data.jobs.filter((job) => job.customer_id === customer.id || job.customer_name === customer.customer_name);
  const lifecycle = data.lifecycle.find((record) => record.linked_id === customer.id || record.linked_name === customer.customer_name);
  const appointments = data.appointments.filter((appointment) => appointment.linked_id === customer.id || appointment.linked_name === customer.customer_name);
  const totalSpend = jobs.filter((job) => (job.status || "").toLowerCase() === "paid").reduce((sum, job) => sum + numeric(job.amount_to_charge), 0);
  const handleJobClick = (job: Job) => { if (statusLabel(job.status) === "New Job") onNewJob(customer); else onSelectJob(job); };
  return <>
    <DetailBack label="Customers" onBack={onBack} />
     <div className="profile-hero card"><div className="avatar profile-avatar">{initials(customer.customer_name)}</div><div className="profile-hero-main"><div className="eyebrow">Customer profile</div><h1>{customer.customer_name}</h1><div className="profile-contact">{customer.phone_number && <span><Phone size={14} />{customer.phone_number}</span>}{customer.email && <span><Mail size={14} />{customer.email}</span>}{customer.address && <span><MapPin size={14} />{customer.address}</span>}</div></div><div className="profile-actions"><span className="badge info">{customer.source || "Customer"}</span><button className="button small" onClick={() => onEdit(customer)}><Pencil size={13} /> Edit</button></div></div>
    <div className="metric-grid profile-metrics"><div className="metric-card"><div className="metric-label">Total jobs</div><div className="metric-value">{jobs.length}</div><div className="metric-note">All studio work</div></div><div className="metric-card"><div className="metric-label">Paid to date</div><div className="metric-value">{money(totalSpend)}</div><div className="metric-note">Completed revenue</div></div><div className="metric-card"><div className="metric-label">Open jobs</div><div className="metric-value">{jobs.filter((job) => !isClosed(job.status)).length}</div><div className="metric-note">In progress or new</div></div><div className="metric-card"><div className="metric-label">Lifecycle</div><div className="metric-value">{lifecycle ? `${Math.round(((lifecycle.completed_steps || []).length / steps.length) * 100)}%` : "—"}</div><div className="metric-note">Journey complete</div></div></div>
    <section className="section"><SectionHeading title="Jobs for this customer" />{jobs.length === 0 ? <div className="empty">No jobs recorded for this customer.</div> : <div className="stack">{jobs.map((job) => <JobRow key={job.id} job={{ ...job, status: statusLabel(job.status) }} onSelect={handleJobClick} />)}</div>}</section>
     <div className="grid-2 detail-grid"><section className="card"><h3>Notes</h3><p className="detail-copy">{customer.notes || "No notes have been added yet."}</p></section><section className="card"><div className="detail-card-heading"><h3>Upcoming appointments</h3><button className="button small" onClick={() => onAddAppointment(customer)}><Plus size={13} /> Add appointment</button></div>{appointments.length === 0 ? <p className="detail-copy">No appointments scheduled.</p> : appointments.slice(0, 3).map((appointment) => <div className="detail-list-row" key={appointment.id}><CalendarDays size={15} /><span>{appointment.title || "Appointment"}<small>{shortDate(appointment.date)}{appointment.time ? ` · ${appointment.time}` : ""}</small></span></div>)}</section></div>
  </>;
}

function JobDetailView({ job, data, onBack, onSelectJob, onEdit }: { job: Job; data: AppData; onBack: () => void; onSelectJob: (job: Job) => void; onEdit: (job: Job) => void }) {
  const customer = data.customers.find((item) => item.id === job.customer_id || item.customer_name === job.customer_name);
  const relatedJobs = customer ? data.jobs.filter((item) => item.customer_id === customer.id || item.customer_name === customer.customer_name) : [];
  return <>
    <DetailBack label="Jobs" onBack={onBack} />
     <div className="profile-hero card"><div className="avatar profile-avatar">{initials(job.customer_name)}</div><div className="profile-hero-main"><div className="eyebrow">Job profile</div><h1>{job.customer_name}</h1><div className="profile-contact"><span>{job.job_id ? `#${job.job_id}` : "Job"}</span>{job.delivery_date && <span><CalendarDays size={14} />Due {fullDate(job.delivery_date)}</span>}</div></div><div className="profile-actions"><StatusBadge status={job.status} /><button className="button small" onClick={() => onEdit(job)}><Pencil size={13} /> Edit</button></div></div>
    <div className="detail-columns"><section className="card detail-main-card"><div className="detail-card-heading"><h3>Work details</h3><StatusBadge status={job.status} /></div><p className="detail-copy prominent">{job.job_details || "No job details added yet."}</p>{job.notes && <><div className="detail-label">Notes</div><p className="detail-copy">{job.notes}</p></>} {job.measurement_notes && <><div className="detail-label">Measurement notes</div><p className="detail-copy">{job.measurement_notes}</p></>}</section><section className="card"><h3>Payment</h3><div className="stat-line"><span>Amount</span><strong>{money(job.amount_to_charge)}</strong></div><div className="stat-line"><span>Deposit paid</span><strong>{money(job.deposit_paid)}</strong></div><div className="stat-line"><span>Balance due</span><strong>{money(job.balance_due)}</strong></div><div className="stat-line"><span>Method</span><strong className="stat-small">{job.payment_method || "—"}</strong></div></section></div>
    <section className="section"><SectionHeading title="Other jobs for this customer" />{relatedJobs.filter((item) => item.id !== job.id).length === 0 ? <div className="empty">This is the only job on file.</div> : <div className="stack">{relatedJobs.filter((item) => item.id !== job.id).map((item) => <JobRow key={item.id} job={item} onSelect={onSelectJob} />)}</div>}</section>
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

function FinancesView({ data, go, onEditExpense }: { data: AppData; go: (view: View) => void; onEditExpense: (expense: Expense) => void }) {
  const revenue = data.jobs.filter((job) => (job.status || "").toLowerCase() === "paid").reduce((sum, job) => sum + numeric(job.amount_to_charge), 0);
  const expenses = data.expenses.reduce((sum, expense) => sum + numeric(expense.amount), 0);
  const netProfit = revenue - expenses;
  const generated = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric" }).format(new Date());
  return <><div className="page-heading"><div><h1>Balance Sheet</h1><p>All Time · Generated {generated}</p></div><button className="button primary" onClick={() => go("new-expense")}><Plus size={15} /> Add Expense</button></div><div className="grid-2"><div className="card"><div className="eyebrow">Total Revenue</div><div className="metric-value">{money(revenue)}</div><div className="stat-line"><span>Total Expenses</span><strong>{money(expenses)}</strong></div><div className="stat-line net"><span>Net Profit</span><strong>{money(netProfit)}</strong></div></div><div className="card"><h3>Quick actions</h3><button className="button" style={{ width: "100%", justifyContent: "space-between", marginBottom: 8 }}><span><FileDown size={15} /> Export financials</span><ArrowUpRight size={14} /></button><button className="button" style={{ width: "100%", justifyContent: "space-between" }}><span><Tag size={15} /> Manage categories</span><ArrowUpRight size={14} /></button></div></div><section className="section"><SectionHeading title="Revenue vs Expenses" /><FinanceChart data={data} /></section><section className="section"><SectionHeading title="Recent Expenses" /><div className="stack">{data.expenses.length === 0 ? <div className="empty">No expenses recorded.</div> : data.expenses.map((expense) => <div className="expense-row" key={expense.id}><div className="metric-icon rose"><CircleDollarSign size={15} /></div><div className="expense-row-main"><div className="row-title">{expense.note || "Expense"}</div><div className="row-meta">{shortDate(expense.date)} · {expense.category || "Other"}</div></div><strong>{money(expense.amount)}</strong><button className="button small" aria-label={`Edit ${expense.note || "expense"}`} onClick={() => onEditExpense(expense)}><Pencil size={13} /> Edit</button></div>)}</div></section></>;
}

function WaitingView({ entries, customers, go, onEdit }: { entries: WaitingEntry[]; customers: Customer[]; go: (view: View) => void; onEdit: (entry: WaitingEntry) => void }) {
  return <><div className="page-heading"><div><h1>Waiting List</h1><p>Keep track of customers waiting for an opening or a material.</p></div><button className="button primary" onClick={() => go("new-waiting")}><Plus size={15} /> Add to list</button></div>{entries.length === 0 ? <div className="empty"><ListFilter size={28} style={{ marginBottom: 10, color: "var(--rose)" }} /><div>No one is waiting right now.</div><div style={{ marginTop: 6, fontSize: 13 }}>New requests can be added here while you plan the next fitting.</div></div> : <div className="stack">{entries.map((entry) => <div className="waiting-row" key={entry.id}><div className="avatar">{initials(entry.name)}</div><div className="waiting-row-main"><div className="row-title">{entry.name}</div><div className="row-description">{entry.request}</div><div className="row-meta">{entry.contact || "No contact details"} · Added {shortDate(entry.addedDate)}</div></div><button className="button small" aria-label={`Edit ${entry.name}`} onClick={() => onEdit(entry)}><Pencil size={13} /> Edit</button></div>)}</div>}</>;
}

function TeamView() {
  return <><div className="page-heading"><div><h1>Team</h1><p>People who keep Rachel&apos;s Seamstress Studio moving.</p></div><button className="button primary"><Plus size={15} /> Invite member</button></div><div className="grid-2"><div className="card"><div className="avatar">RV</div><h3 style={{ marginTop: 12 }}>Rachel Valenzuela</h3><div className="muted">Owner · Studio manager</div><div className="stat-line" style={{ marginTop: 14 }}><span>Access</span><strong>Admin</strong></div></div><div className="card"><div className="avatar green">AS</div><h3 style={{ marginTop: 12 }}>Alterations team</h3><div className="muted">Shared workspace</div><div className="stat-line" style={{ marginTop: 14 }}><span>Open jobs</span><strong>3</strong></div></div></div></>;
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
  const [deliveryDate, setDeliveryDate] = useState("");
  const [status, setStatus] = useState("New Job");
  const [payment, setPayment] = useState("Cash");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const customer = data.customers.find((item) => item.customer_name === customerName);
    onCreate({ id: `local-${Date.now()}`, job_id: `JOB-${String(data.jobs.length + 1).padStart(4, "0")}`, customer_id: customer?.id, customer_name: customerName || "New customer", job_details: details, status, amount_to_charge: Number(amount || 0), balance_due: Number(amount || 0), delivery_date: deliveryDate, payment_method: payment });
    go("jobs");
  };
  const selectedCustomer = data.customers.find((customer) => customer.customer_name === customerName);
  return <><div className="page-heading"><div><h1>Add Job</h1><p>Capture the work, price, and pickup date in one place.</p></div><button className="button" onClick={() => go("jobs")}>Cancel</button></div><form className="card form-card" onSubmit={submit}><div className="form-grid"><div className="field"><label htmlFor="customer">Customer</label><input id="customer" list="job-customers" value={customerName} onChange={(event) => setCustomerName(event.target.value)} placeholder="Search customers..." required /><datalist id="job-customers">{data.customers.map((customer) => <option key={customer.id} value={customer.customer_name}>{customer.phone_number || customer.email || ""}</option>)}</datalist>{selectedCustomer && <div className="autocomplete-meta">{selectedCustomer.phone_number || "No phone"}{selectedCustomer.email ? ` · ${selectedCustomer.email}` : ""}{selectedCustomer.address ? ` · ${selectedCustomer.address}` : ""}</div>}</div><div className="field"><label htmlFor="status">Status</label><select id="status" value={status} onChange={(event) => setStatus(event.target.value)}><option>New Job</option><option>In Progress</option><option>Ready for Pickup</option><option>Delivered</option><option>Paid</option></select></div><div className="field full"><label htmlFor="details">Job details</label><textarea id="details" value={details} onChange={(event) => setDetails(event.target.value)} placeholder="Describe the alterations or project..." required /></div><div className="field"><label htmlFor="amount">Amount to charge</label><input id="amount" type="number" min="0" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00" /></div><div className="field"><label htmlFor="delivery">Delivery date</label><input id="delivery" type="date" value={deliveryDate} onChange={(event) => setDeliveryDate(event.target.value)} /></div><div className="field"><label htmlFor="payment">Payment method</label><select id="payment" value={payment} onChange={(event) => setPayment(event.target.value)}><option>Cash</option><option>Card</option><option>Check</option><option>Venmo</option><option>Other</option></select></div></div><div className="form-actions"><button type="button" className="button" onClick={() => go("jobs")}>Cancel</button><button type="submit" className="button primary"><Plus size={15} /> Save Job</button></div></form></>;
}

function NewExpenseView({ onCreate, go }: { onCreate: (expense: Expense) => void; go: (view: View) => void }) {
  const [note, setNote] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [category, setCategory] = useState("Supplies");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onCreate({ id: `local-expense-${Date.now()}`, note, amount: Number(amount), date, category });
    go("finances");
  };
  return <><div className="page-heading"><div><h1>Add Expense</h1><p>Record a studio cost so your finances stay up to date.</p></div><button className="button" onClick={() => go("finances")}>Cancel</button></div><form className="card form-card" onSubmit={submit}><div className="form-grid"><div className="field full"><label htmlFor="expense-note">Description</label><input id="expense-note" value={note} onChange={(event) => setNote(event.target.value)} placeholder="e.g. Silk lining for bridal gown" required /></div><div className="field"><label htmlFor="expense-amount">Amount</label><input id="expense-amount" type="number" min="0.01" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00" required /></div><div className="field"><label htmlFor="expense-date">Date</label><input id="expense-date" type="date" value={date} onChange={(event) => setDate(event.target.value)} required /></div><div className="field"><label htmlFor="expense-category">Category</label><select id="expense-category" value={category} onChange={(event) => setCategory(event.target.value)}><option>Supplies</option><option>Fabric</option><option>Equipment</option><option>Rent &amp; utilities</option><option>Marketing</option><option>Other</option></select></div></div><div className="form-actions"><button type="button" className="button" onClick={() => go("finances")}>Cancel</button><button type="submit" className="button primary"><Plus size={15} /> Save Expense</button></div></form></>;
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
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);
  const [editingJob, setEditingJob] = useState<Job | null>(null);
  const [editingLead, setEditingLead] = useState<Lead | null>(null);
  const [editingAppointment, setEditingAppointment] = useState<Appointment | null>(null);
  const [editingExpense, setEditingExpense] = useState<Expense | null>(null);
  const [editingWaiting, setEditingWaiting] = useState<WaitingEntry | null>(null);
  const [editingLifecycle, setEditingLifecycle] = useState<Lifecycle | null>(null);

  useEffect(() => {
    if (!supabase) return;
    let cancelled = false;
    Promise.all([
      supabase.from("customers").select("*").order("customer_name"),
      supabase.from("jobs").select("*").order("delivery_date", { ascending: true }),
      supabase.from("leads").select("*").order("created_date", { ascending: false }),
      supabase.from("expenses").select("*").order("date", { ascending: false }),
      supabase.from("appointments").select("*").order("date", { ascending: true }),
      supabase.from("customer_lifecycle").select("*").order("linked_name"),
    ]).then(([customers, jobs, leads, expenses, appointments, lifecycle]) => {
      if (cancelled) return;
      const next = { customers: (customers.data || []) as Customer[], jobs: (jobs.data || []) as Job[], leads: (leads.data || []) as Lead[], expenses: (expenses.data || []) as Expense[], appointments: (appointments.data || []) as Appointment[], lifecycle: (lifecycle.data || []) as Lifecycle[] };
      if (Object.values(next).some((rows) => rows.length > 0)) setData(next);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem("stitchflow-data", JSON.stringify(data));
      window.localStorage.setItem("stitchflow-waiting-list", JSON.stringify(waitingList));
    } catch {
      // Storage is optional; the in-memory workspace still remains usable.
    }
  }, [data, waitingList]);

  const go = (next: View) => { setView(next); setDetail(null); setNewJobCustomer(null); setNewAppointmentCustomer(null); setSearchOpen(false); setMobileMenuOpen(false); setGlobalQuery(""); window.scrollTo({ top: 0, behavior: "smooth" }); };
  const openCustomer = (customer: Customer) => { setView("customers"); setDetail({ type: "customer", id: customer.id }); window.scrollTo({ top: 0, behavior: "smooth" }); };
  const openJob = (job: Job) => { setView("jobs"); setDetail({ type: "job", id: job.id }); window.scrollTo({ top: 0, behavior: "smooth" }); };
  const openLead = (lead: Lead) => { setView("leads"); setDetail({ type: "lead", id: lead.id }); window.scrollTo({ top: 0, behavior: "smooth" }); };
  const openNewJobForCustomer = (customer: Customer) => { setNewJobCustomer(customer); setDetail(null); setView("new-job"); window.scrollTo({ top: 0, behavior: "smooth" }); };
  const openNewAppointmentForCustomer = (customer: Customer) => { setNewAppointmentCustomer(customer); setDetail(null); setView("new-appointment"); window.scrollTo({ top: 0, behavior: "smooth" }); };
  const closeDetail = () => { setDetail(null); window.scrollTo({ top: 0, behavior: "smooth" }); };
  const toast = (message: string) => { setToastText(message); window.setTimeout(() => setToastText(""), 2800); };
  const createJob = (job: Job) => { setData((current) => ({ ...current, jobs: [job, ...current.jobs] })); toast("Job saved to your studio workspace."); if (supabase) void supabase.from("jobs").insert(job); };
  const createExpense = (expense: Expense) => { setData((current) => ({ ...current, expenses: [expense, ...current.expenses] })); toast("Expense added to your studio finances."); if (supabase) void supabase.from("expenses").insert(expense); };
  const createWaitingEntry = (entry: WaitingEntry) => { setWaitingList((current) => [entry, ...current]); toast("Customer added to the waiting list."); };
  const createAppointment = (appointment: Appointment) => { setData((current) => ({ ...current, appointments: [appointment, ...current.appointments] })); toast("Appointment added to your studio calendar."); if (supabase) void supabase.from("appointments").insert(appointment); };
  const completeAppointment = (appointment: Appointment) => { const completed = { ...appointment, status: "Completed" }; setData((current) => ({ ...current, appointments: current.appointments.map((item) => item.id === appointment.id ? completed : item) })); toast("Appointment marked completed."); if (supabase) void supabase.from("appointments").update({ status: "Completed" }).eq("id", appointment.id); };
  const updateCustomer = (updated: Customer) => {
    const previous = data.customers.find((item) => item.id === updated.id);
    setData((current) => ({ ...current, customers: current.customers.map((item) => item.id === updated.id ? updated : item), jobs: current.jobs.map((job) => job.customer_id === updated.id || job.customer_name === previous?.customer_name ? { ...job, customer_name: updated.customer_name, phone_number: updated.phone_number, email: updated.email } : job) }));
    if (supabase) {
      void supabase.from("customers").update({ ...updated, updated_date: new Date().toISOString() }).eq("id", updated.id);
      void supabase.from("jobs").update({ customer_name: updated.customer_name, phone_number: updated.phone_number, updated_date: new Date().toISOString() }).eq("customer_id", updated.id);
    }
    setEditingCustomer(null);
    toast("Customer updated.");
  };
  const updateJob = (updated: Job) => {
    setData((current) => ({ ...current, jobs: current.jobs.map((item) => item.id === updated.id ? updated : item) }));
    if (supabase) {
      const { email: _email, ...jobFields } = updated;
      void supabase.from("jobs").update({ ...jobFields, updated_date: new Date().toISOString() }).eq("id", updated.id);
    }
    setEditingJob(null);
    toast("Job updated.");
  };
  const updateLead = (updated: Lead) => {
    setData((current) => ({ ...current, leads: current.leads.map((item) => item.id === updated.id ? updated : item) }));
    if (supabase) void supabase.from("leads").update({ ...updated, updated_date: new Date().toISOString() }).eq("id", updated.id);
    setEditingLead(null);
    toast("Lead updated.");
  };
  const updateAppointment = (updated: Appointment) => {
    setData((current) => ({ ...current, appointments: current.appointments.map((item) => item.id === updated.id ? updated : item) }));
    if (supabase) void supabase.from("appointments").update({ ...updated, updated_date: new Date().toISOString() }).eq("id", updated.id);
    setEditingAppointment(null);
    toast("Appointment updated.");
  };
  const updateExpense = (updated: Expense) => {
    setData((current) => ({ ...current, expenses: current.expenses.map((item) => item.id === updated.id ? updated : item) }));
    if (supabase) void supabase.from("expenses").update({ ...updated, updated_date: new Date().toISOString() }).eq("id", updated.id);
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
    if (supabase) void supabase.from("customer_lifecycle").update({ ...updated, updated_date: new Date().toISOString() }).eq("id", updated.id);
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

  const title = navItems.find((item) => item.key === view)?.label || (view === "new-job" ? "Add Job" : view === "new-expense" ? "Add Expense" : view === "new-waiting" ? "Add to waiting list" : view === "new-appointment" ? "New Appointment" : "Dashboard");
  const selectedCustomer = detail?.type === "customer" ? data.customers.find((item) => item.id === detail.id) : undefined;
  const selectedJob = detail?.type === "job" ? data.jobs.find((item) => item.id === detail.id) : undefined;
  const selectedLead = detail?.type === "lead" ? data.leads.find((item) => item.id === detail.id) : undefined;

  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><div className="brand-mark"><Scissors size={18} /></div><div><div className="brand-name">Stitch &amp; Thread</div><div className="brand-subtitle">Studio Manager</div></div></div><button className="search-box" style={{ width: "100%" }} onClick={() => setSearchOpen(true)}><Search size={16} /><span style={{ fontSize: 14, color: "#a49e97" }}>Search...</span></button><nav className="nav">{navItems.map(({ key, label, icon: Icon }) => <button key={key} className={`nav-item ${view === key ? "active" : ""}`} onClick={() => go(key)}><Icon size={17} />{label}</button>)}<button className={`nav-item accent ${view === "new-job" ? "active" : ""}`} onClick={() => go("new-job")}><Plus size={17} />Add Job</button></nav><div className="studio-name">Rachel&apos;s Seamstress Studio</div></aside>
    <main className="main-shell"><div className="mobile-topbar"><button className="icon-button" aria-label={mobileMenuOpen ? "Close navigation menu" : "Open navigation menu"} aria-expanded={mobileMenuOpen} onClick={() => setMobileMenuOpen((open) => !open)}>{mobileMenuOpen ? <X size={20} /> : <Menu size={20} />}</button><div className="brand-name">Stitch &amp; Thread</div><button className="icon-button" aria-label="Search studio" onClick={() => { setMobileMenuOpen(false); setSearchOpen(true); }}><Search size={18} /></button></div>{mobileMenuOpen && <div className="mobile-menu-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setMobileMenuOpen(false)}><div className="mobile-menu-panel" role="dialog" aria-modal="true" aria-label="Navigation menu"><div className="mobile-menu-heading"><div><div className="brand-name">Stitch &amp; Thread</div><div className="brand-subtitle">Studio Manager</div></div><button className="icon-button" aria-label="Close navigation menu" onClick={() => setMobileMenuOpen(false)}><X size={18} /></button></div><nav className="mobile-menu-nav">{navItems.map(({ key, label, icon: Icon }) => <button key={key} className={`nav-item ${view === key ? "active" : ""}`} onClick={() => go(key)}><Icon size={17} />{label}</button>)}<button className={`nav-item accent ${view === "new-job" ? "active" : ""}`} onClick={() => go("new-job")}><Plus size={17} />Add Job</button></nav></div></div>}<div className="content" aria-label={`${title} page`}>
      {view === "dashboard" && <DashboardView data={data} go={go} onSelectJob={openJob} />}
      {view === "jobs" && selectedJob ? <JobDetailView job={selectedJob} data={data} onBack={closeDetail} onSelectJob={openJob} onEdit={setEditingJob} /> : null}
      {view === "jobs" && (!detail || detail.type !== "job") && <JobsView data={data} go={go} toast={toast} onSelect={openJob} onEdit={setEditingJob} />}
      {view === "customers" && selectedCustomer ? <CustomerDetailView customer={selectedCustomer} data={data} onBack={closeDetail} onSelectJob={openJob} onNewJob={openNewJobForCustomer} onAddAppointment={openNewAppointmentForCustomer} onEdit={setEditingCustomer} /> : null}
      {view === "customers" && (!detail || detail.type !== "customer") && <CustomersView data={data} go={go} onSelect={openCustomer} onEdit={setEditingCustomer} />}
      {view === "leads" && selectedLead ? <LeadDetailView lead={selectedLead} onBack={closeDetail} onEdit={setEditingLead} /> : null}
      {view === "leads" && (!detail || detail.type !== "lead") && <LeadsView data={data} onSelect={openLead} onEdit={setEditingLead} />}
      {view === "appointments" && <AppointmentsView data={data} go={go} onComplete={completeAppointment} onEdit={setEditingAppointment} />}
      {view === "finances" && <FinancesView data={data} go={go} onEditExpense={setEditingExpense} />}
      {view === "waiting" && <WaitingView entries={waitingList} customers={data.customers} go={go} onEdit={setEditingWaiting} />}
      {view === "team" && <TeamView />}
      {view === "lifecycle" && <LifecycleView data={data} onEdit={setEditingLifecycle} />}
      {view === "new-job" && <NewJobView data={data} onCreate={createJob} go={go} initialCustomer={newJobCustomer} />}
      {view === "new-expense" && <NewExpenseView onCreate={createExpense} go={go} />}
      {view === "new-waiting" && <NewWaitingView customers={data.customers} onCreate={createWaitingEntry} go={go} />}
      {view === "new-appointment" && <NewAppointmentView data={data} onCreate={createAppointment} go={go} initialCustomer={newAppointmentCustomer} />}
    </div></main>
    {editingCustomer && <EditCustomerModal customer={editingCustomer} onClose={() => setEditingCustomer(null)} onSave={updateCustomer} />}
    {editingJob && <EditJobModal job={editingJob} customers={data.customers} onClose={() => setEditingJob(null)} onSave={updateJob} />}
    {editingLead && <EditLeadModal lead={editingLead} onClose={() => setEditingLead(null)} onSave={updateLead} />}
    {editingAppointment && <EditAppointmentModal appointment={editingAppointment} customers={data.customers} onClose={() => setEditingAppointment(null)} onSave={updateAppointment} />}
    {editingExpense && <EditExpenseModal expense={editingExpense} onClose={() => setEditingExpense(null)} onSave={updateExpense} />}
    {editingWaiting && <EditWaitingModal entry={editingWaiting} customers={data.customers} onClose={() => setEditingWaiting(null)} onSave={updateWaiting} />}
    {editingLifecycle && <EditLifecycleModal record={editingLifecycle} onClose={() => setEditingLifecycle(null)} onSave={updateLifecycle} />}
    {searchOpen && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setSearchOpen(false)}><div className="modal" role="dialog" aria-modal="true" aria-label="Search your studio"><div className="modal-heading"><h2>Search your studio</h2><button className="icon-button" aria-label="Close search" onClick={() => setSearchOpen(false)}><X size={18} /></button></div><SearchBox value={globalQuery} onChange={setGlobalQuery} placeholder="Search customers, jobs, or leads..." />{globalQuery && <div className="search-results" style={{ marginTop: 12 }}>{searchResults.length === 0 ? <div className="empty">No matches found.</div> : searchResults.map((result, index) => <button className="search-result" key={`${result.type}-${result.title}-${index}`} onClick={() => { setSearchOpen(false); setGlobalQuery(""); if (result.type === "Customer") openCustomer(data.customers.find((item) => item.id === result.id) || data.customers[0]); else if (result.type === "Job") openJob(data.jobs.find((item) => item.id === result.id) || data.jobs[0]); else openLead(data.leads.find((item) => item.id === result.id) || data.leads[0]); }}><div className="avatar">{initials(result.title)}</div><div><div className="row-title">{result.title}</div><small>{result.type} · {result.detail}</small></div></button>)}</div>}</div></div>}
    {toastText && <div className="toast" role="status">{toastText}</div>}
  </div>;
}
