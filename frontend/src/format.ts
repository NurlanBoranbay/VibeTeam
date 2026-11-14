const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export const money = (v: number) =>
  v.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 });

export const money0 = (v: number) => money(Math.round(v));

/** "2027-09" -> "September 2027" */
export function monthName(ym: string | null | undefined): string {
  if (!ym) return "—";
  const [y, m] = ym.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

export const shortMonth = (ym: string) => MONTHS[Number(ym.split("-")[1]) - 1].slice(0, 3);

/** "2026-12-05" -> "Dec 5" */
export function dateLabel(iso: string | null): string {
  if (!iso) return "";
  const [, m, d] = iso.split("-").map(Number);
  return `${MONTHS[m - 1].slice(0, 3)} ${d}`;
}

/** "2026-11" + due day 31 -> "Nov 30" (clamped to the month's length). */
export function dueLabel(ym: string, dueDay: number | null): string {
  if (!dueDay) return shortMonth(ym);
  const [y, m] = ym.split("-").map(Number);
  return `${shortMonth(ym)} ${Math.min(dueDay, new Date(y, m, 0).getDate())}`;
}

/** The next calendar date a due day falls on, from today. */
export function nextDue(dueDay: number | null, today = new Date()): { label: string; time: number } {
  if (!dueDay) return { label: "this month", time: Number.MAX_SAFE_INTEGER };
  let y = today.getFullYear();
  let m = today.getMonth();
  if (dueDay < today.getDate()) m += 1;
  const last = new Date(y, m + 1, 0).getDate();
  const d = new Date(y, m, Math.min(dueDay, last));
  return { label: `${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}`, time: d.getTime() };
}

export const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v)}%`);

export const duration = (months: number) => (months >= 12 ? `${Math.floor(months / 12)} yr${months % 12 ? ` ${months % 12} mo` : ""}` : `${months} months`);
