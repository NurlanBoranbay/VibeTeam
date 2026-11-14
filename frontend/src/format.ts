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

/** "2026-12-05" -> "Dec 5" */
export function dateLabel(iso: string | null): string {
  if (!iso) return "";
  const [, m, d] = iso.split("-").map(Number);
  return `${MONTHS[m - 1].slice(0, 3)} ${d}`;
}

/** "2027-02-13" -> "Feb 13, 2027" */
export function fullDate(iso: string | null): string {
  if (!iso) return "";
  return `${dateLabel(iso)}, ${iso.slice(0, 4)}`;
}

/** The dates one payment cycle covers: "Nov 14 – Dec 13" */
export const rangeLabel = (startIso: string, endIso: string) => `${dateLabel(startIso)} – ${dateLabel(endIso)}`;

/** One decimal at most: 50 -> "50%", 11.7 -> "11.7%" */
export const pct = (v: number | null) => (v === null ? "—" : `${Number(v.toFixed(1))}%`);

export const cycles = (n: number) => `${n} payment cycle${n === 1 ? "" : "s"}`;
