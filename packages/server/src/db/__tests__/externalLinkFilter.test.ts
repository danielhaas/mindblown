/**
 * The issue-link SQL pre-filter (#310) renders the jsonb containment the
 * GIN index on external_links answers — one bound JSON parameter per id —
 * and degrades to true/false at the edges.
 */
import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { linksAnyExternalId } from '../externalLinkFilter.js';

const render = (ids: string[]) => new PgDialect().sqlToQuery(linksAnyExternalId(ids));

describe('linksAnyExternalId (#310)', () => {
  it('one containment per distinct id, OR-ed, ids bound as JSON parameters', () => {
    const q = render(['dan/r#5', 'dan/r#6', 'dan/r#5']);
    expect(q.sql).toBe('("nodes"."external_links" @> $1::jsonb OR "nodes"."external_links" @> $2::jsonb)');
    expect(q.params).toEqual(['[{"externalId":"dan/r#5"}]', '[{"externalId":"dan/r#6"}]']);
  });

  it('no ids → false; more than the cap → true (the caller scans as before)', () => {
    expect(render([]).sql).toBe('false');
    expect(render(Array.from({ length: 501 }, (_, i) => `o/r#${i}`)).sql).toBe('true');
  });
});
