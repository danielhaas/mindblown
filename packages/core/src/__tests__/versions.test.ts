import { describe, it, expect } from 'vitest';
import { compareVersions, findVersionOrderInversions } from '../versions.js';

function v(name: string, targetDate: string | null, sortOrder = 0) {
  return { name, targetDate, sortOrder };
}

const order = (list: ReturnType<typeof v>[]) =>
  [...list].sort(compareVersions).map((x) => x.name);

describe('compareVersions', () => {
  it('orders by target date ascending', () => {
    expect(order([v('V2', '2026-10-31'), v('V1', '2026-08-21')])).toEqual(['V1', 'V2']);
  });

  it('puts undated versions last', () => {
    expect(
      order([v('V3', null), v('V1', '2026-08-21'), v('V2', null), v('MVP', '2026-06-15')]),
    ).toEqual(['MVP', 'V1', 'V2', 'V3']);
  });

  it('breaks undated ties by semver, not lexically', () => {
    // "V10" < "V2" lexically — the semver tiebreak has to win.
    expect(order([v('V10', null), v('V2', null)])).toEqual(['V2', 'V10']);
  });

  it('honours sortOrder as the manual override when dates match', () => {
    expect(
      order([v('B', '2026-08-21', 2), v('A', '2026-08-21', 1)]),
    ).toEqual(['A', 'B']);
  });

  it('is a total order — sorting is stable and idempotent', () => {
    const list = [v('V1.5', '2026-10-31'), v('V1', '2026-08-21'), v('V2', null)];
    const once = [...list].sort(compareVersions);
    const twice = [...once].sort(compareVersions);
    expect(twice.map((x) => x.name)).toEqual(once.map((x) => x.name));
  });

  it('regression: a dated follow-up does not sort ahead of the release it follows', () => {
    // The Fulcrum CRM case — "V1.5 follow-up" dated before V1.5 chained
    // ahead of it in the forecast. Fixed by dating it after V1.5.
    expect(
      order([v('V1.5 follow-up', '2026-11-30'), v('V1.5', '2026-10-31')]),
    ).toEqual(['V1.5', 'V1.5 follow-up']);
  });
});

describe('findVersionOrderInversions', () => {
  it('is empty when dates agree with sortOrder', () => {
    expect(
      findVersionOrderInversions([v('V1', '2026-09-02', 10), v('V1.5', '2026-09-28', 15)]),
    ).toEqual([]);
  });

  it('flags a lower-sortOrder version dated after a higher one (the #331 case)', () => {
    const out = findVersionOrderInversions([
      v('V1', '2026-12-18', 10),
      v('V1.5', '2026-09-28', 15),
    ]);
    expect(out).toEqual([
      {
        a: 'V1.5',
        b: 'V1',
        reason:
          '"V1.5" (2026-09-28) is dated before "V1" (2026-12-18) but sorts after it (sortOrder 15 > 10)',
      },
    ]);
  });

  it('falls back to the semver in the name when sortOrders tie', () => {
    // MCP create_version never sets sortOrder, so this is the common shape.
    const out = findVersionOrderInversions([
      v('V1.5', '2026-09-28', 0),
      v('V1', '2026-12-18', 0),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ a: 'V1.5', b: 'V1' });
    expect(out[0].reason).toBe(
      '"V1.5" (2026-09-28) is dated before "V1" (2026-12-18) but sorts after it (by name, "V1.5" > "V1")',
    );
  });

  it('semver tiebreak is numeric, not lexical (V10 after V2)', () => {
    expect(findVersionOrderInversions([v('V2', '2026-10-01'), v('V10', '2026-11-01')])).toEqual([]);
    expect(findVersionOrderInversions([v('V2', '2026-11-01'), v('V10', '2026-10-01')])).toHaveLength(1);
  });

  it('ignores undated versions and names without a semver on a sortOrder tie', () => {
    expect(
      findVersionOrderInversions([
        v('V1', '2026-12-18', 0),
        v('V1.5', null, 0),
        v('MVP: Onboarding', '2026-01-01', 0),
      ]),
    ).toEqual([]);
  });

  it('sortOrder wins over the name when the two differ', () => {
    // Manual order puts V2 first (sortOrder 1 < 5); the dates agree with
    // it, so the name-order ("V1" < "V2") must NOT produce a warning.
    expect(
      findVersionOrderInversions([v('V2', '2026-10-01', 1), v('V1', '2026-11-01', 5)]),
    ).toEqual([]);
    // Same names, sortOrder now says V1 first — the dates contradict it.
    expect(
      findVersionOrderInversions([v('V2', '2026-10-01', 5), v('V1', '2026-11-01', 1)]),
    ).toEqual([
      {
        a: 'V2',
        b: 'V1',
        reason: '"V2" (2026-10-01) is dated before "V1" (2026-11-01) but sorts after it (sortOrder 5 > 1)',
      },
    ]);
  });

  it('equal dates are never an inversion', () => {
    expect(
      findVersionOrderInversions([v('V1', '2026-10-01', 10), v('V1.5', '2026-10-01', 15)]),
    ).toEqual([]);
  });

  it('reports every contradicting pair', () => {
    const out = findVersionOrderInversions([
      v('V1', '2026-12-18'),
      v('V1.5', '2026-09-28'),
      v('V2', '2026-10-15'),
    ]);
    expect(out.map((i) => `${i.a}<${i.b}`).sort()).toEqual(['V1.5<V1', 'V2<V1']);
  });
});
