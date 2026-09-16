import csv
import json
from pathlib import Path

DOWNLOADS = Path(r"C:\Users\16035\Downloads")
OUT = Path("data/seed.json")

FILES = {
    "customers": "Customer_export.csv",
    "jobs": "Job_export.csv",
    "leads": "Lead_export.csv",
    "expenses": "Expense_export.csv",
    "appointments": "Appointment_export.csv",
    "lifecycle": "CustomerLifecycle_export.csv",
}

NUMERIC_FIELDS = {
    "amount", "amount_to_charge", "balance_due", "deposit_paid", "tip_received",
    "time_spent_minutes", "waist", "bust", "inseam", "hem_length", "sleeves",
}

def normalize(row):
    out = {}
    for key, value in row.items():
        value = (value or "").strip()
        if key in {"photo_urls", "time_sessions", "completed_steps"} and value:
            try:
                out[key] = json.loads(value)
                continue
            except json.JSONDecodeError:
                pass
        if key in NUMERIC_FIELDS and value:
            try:
                out[key] = float(value) if "." in value else int(value)
                continue
            except ValueError:
                pass
        if value.lower() in {"true", "false"}:
            out[key] = value.lower() == "true"
        else:
            out[key] = value
    return out

def read_csv(name):
    path = DOWNLOADS / name
    if not path.exists() or path.stat().st_size == 0:
        return []
    with path.open("r", encoding="utf-8-sig", newline="") as fh:
        return [normalize(row) for row in csv.DictReader(fh)]

OUT.parent.mkdir(parents=True, exist_ok=True)
data = {key: read_csv(filename) for key, filename in FILES.items()}
OUT.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps({key: len(value) for key, value in data.items()}))
