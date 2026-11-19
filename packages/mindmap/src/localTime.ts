/**
 * Timestamps travel as absolute instants (ISO 8601 with Z or an offset);
 * the viewer reads them on the browser's own clock (#595). These helpers
 * are the two places that turn an instant into something a person reads.
 */

/** The calendar day of `d` at the viewer's local midnight boundary, as YYYY-MM-DD. */
export function localDay(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The full local date-time with the zone abbreviation, for a hover title: "Oct 20, 2026, 15:40 GMT+2". */
export function localDateTime(d: Date): string {
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
  });
}
