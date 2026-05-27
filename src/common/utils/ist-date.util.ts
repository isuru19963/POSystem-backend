/** Calendar date YYYY-MM-DD in Asia/Kolkata */
export function istDateString(d = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** Human-readable date in IST, e.g. "Mon, 19 May 2026". */
export function istDateHuman(d = new Date()): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(d);
}

/** Current hour (0–23) in Asia/Kolkata. */
export function istHour(d = new Date()): number {
  const h = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    hour12: false,
  }).format(d);
  return parseInt(h, 10);
}
