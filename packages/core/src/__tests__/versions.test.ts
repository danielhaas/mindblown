import { describe, it, expect } from 'vitest';
import { compareVersions } from '../versions.js';

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
