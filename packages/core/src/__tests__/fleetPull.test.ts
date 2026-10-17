import { describe, it, expect } from 'vitest';
import { advanceFleetPull, orderFleetPull, type FleetPullDeficits } from '../fleet.js';

/** Run `n` grants; `hasWork(mapId, step)` says whether a map has a ticket that round. */
function simulate(
  maps: Array<{ mapId: string; share: number }>,
  n: number,
  hasWork: (mapId: string, step: number) => boolean = () => true,
): string[] {
  let deficits: FleetPullDeficits = {};
  const out: string[] = [];
  for (let step = 0; step < n; step++) {
    const eligible = maps.filter((m) => hasWork(m.mapId, step));
    if (eligible.length === 0) continue;
    const winner = orderFleetPull(eligible, deficits)[0];
    out.push(winner.mapId);
    deficits = advanceFleetPull(deficits, eligible, winner.mapId, maps.map((m) => m.mapId));
  }
  return out;
}

const count = (xs: string[], id: string) => xs.filter((x) => x === id).length;

describe('fleet pull — smooth weighted round-robin (#478)', () => {
  it('grants shares 2:1 in a 2:1 ratio, interleaved', () => {
    const seq = simulate([{ mapId: 'A', share: 2 }, { mapId: 'B', share: 1 }], 9);
    expect(seq).toEqual(['A', 'B', 'A', 'A', 'B', 'A', 'A', 'B', 'A']);
    expect(count(seq, 'A')).toBe(6);
    expect(count(seq, 'B')).toBe(3);
  });

  it('equal shares alternate, oldest map first', () => {
    expect(simulate([{ mapId: 'A', share: 1 }, { mapId: 'B', share: 1 }], 4)).toEqual(['A', 'B', 'A', 'B']);
  });

  it('holds the ratio over a long run with fractional shares', () => {
    const seq = simulate([{ mapId: 'A', share: 0.5 }, { mapId: 'B', share: 1.5 }], 400);
    expect(count(seq, 'B')).toBe(300);
  });

  it('a map with nothing to give is skipped without blocking the other', () => {
    const seq = simulate([{ mapId: 'A', share: 2 }, { mapId: 'B', share: 1 }], 6, (id) => id === 'B');
    expect(seq).toEqual(['B', 'B', 'B', 'B', 'B', 'B']);
  });

  it("an idle map doesn't bank credit and burst afterwards", () => {
    // A is empty for 10 rounds, then has work again: B keeps its 1-in-3.
    const seq = simulate([{ mapId: 'A', share: 2 }, { mapId: 'B', share: 1 }], 16, (id, step) => id === 'B' || step >= 10);
    expect(seq.slice(10)).toEqual(['A', 'B', 'A', 'A', 'B', 'A']);
  });

  it('drops credit of maps that left the fleet', () => {
    const next = advanceFleetPull({ gone: 5, A: 1 }, [{ mapId: 'A', share: 1 }], 'A', ['A']);
    expect(next).toEqual({ A: 1 });
  });

  it('treats junk credit as 0', () => {
    const order = orderFleetPull([{ mapId: 'A', share: 1 }, { mapId: 'B', share: 1 }], { A: Number.NaN, B: 0.5 });
    expect(order.map((m) => m.mapId)).toEqual(['B', 'A']);
  });
});
