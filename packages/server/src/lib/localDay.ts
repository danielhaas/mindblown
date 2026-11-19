/** Calendar day and hour in a time zone — the daily mail's and the daily check's clock. */

/** The calendar day at `now` in `timeZone`, as YYYY-MM-DD. */
export function localDay(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function localHour(now: Date, timeZone: string): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(now));
}
