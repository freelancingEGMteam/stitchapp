import seed from "@/data/seed.json";

export type Customer = {
  id: string;
  customer_id?: string;
  customer_name: string;
  phone_number?: string;
  email?: string;
  address?: string;
  source?: string;
  referred_by?: string;
  notes?: string;
  created_date?: string;
  updated_date?: string;
};

export type Job = {
  id: string;
  job_id?: string;
  customer_id?: string;
  customer_name: string;
  phone_number?: string;
  email?: string;
  job_details?: string;
  notes?: string;
  measurement_notes?: string;
  source?: string;
  status?: string;
  start_date?: string;
  delivery_date?: string;
  amount_to_charge?: number | string;
  deposit_paid?: number | string;
  balance_due?: number | string;
  tip_received?: number | string;
  payment_method?: string;
  time_spent_minutes?: number | string;
};

export type Lead = {
  id: string;
  name: string;
  phone_number?: string;
  email?: string;
  location?: string;
  source?: string;
  interested_in?: string;
  notes?: string;
  status?: string;
};

export type Expense = {
  id: string;
  date?: string;
  note?: string;
  amount?: number | string;
  receipt_url?: string;
  category?: string;
  job_id?: string;
};

export type Appointment = {
  id: string;
  date?: string;
  time?: string;
  title?: string;
  notes?: string;
  linked_name?: string;
  linked_type?: string;
  linked_id?: string;
  status?: string;
};

export type Lifecycle = {
  id: string;
  linked_name?: string;
  linked_type?: string;
  linked_id?: string;
  payment_method?: string;
  completed_steps?: number[];
};

export type AppData = {
  customers: Customer[];
  jobs: Job[];
  leads: Lead[];
  expenses: Expense[];
  appointments: Appointment[];
  lifecycle: Lifecycle[];
};

export const seedData = seed as AppData;

export const money = (value: number | string | undefined) => {
  const amount = Number(value || 0);
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
};

export const shortDate = (value?: string) => {
  if (!value) return "—";
  const parsed = new Date(`${value}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(parsed);
};

export const fullDate = (value?: string) => {
  if (!value) return "—";
  const parsed = new Date(`${value}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(parsed);
};

export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();

export const statusTone = (status?: string) => {
  const normalized = (status || "").toLowerCase();
  if (normalized.includes("paid") || normalized.includes("delivered")) return "success";
  if (normalized.includes("progress")) return "warning";
  if (normalized.includes("cancel")) return "muted";
  if (normalized.includes("ready")) return "ready";
  return "info";
};
