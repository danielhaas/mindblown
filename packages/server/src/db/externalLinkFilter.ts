import { sql, type SQL } from 'drizzle-orm';
import { nodes } from './schema.js';

/**
 * SQL pre-filter: rows whose external_links contain one of these issue
 * refs (`owner/repo#N`) — a jsonb containment the GIN index on
 * external_links answers (#310). Callers keep their exact JS check
 * (forge kind, sync flags) on the few rows that come back; before, every
 * webhook event loaded and scanned every live node. Above
 * PREFILTER_MAX ids (a first catch-up after downtime) the predicate is
 * `true` and the caller scans as before.
 */
const PREFILTER_MAX = 500;
export function linksAnyExternalId(externalIds: Iterable<string>): SQL {
  const ids = [...new Set(externalIds)];
  if (ids.length === 0) return sql`false`;
  if (ids.length > PREFILTER_MAX) return sql`true`;
  const each = ids.map((id) => sql`${nodes.externalLinks} @> ${JSON.stringify([{ externalId: id }])}::jsonb`);
  return sql`(${sql.join(each, sql` OR `)})`;
}
