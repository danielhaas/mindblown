import { describe, it, expect } from 'vitest';
import type { Node, Version } from '@mindblown/core';
import type { ChangeEvent, MapMember } from '../api.js';
import {
  gateChips,
  toggleGateEntry,
  versionGateOptions,
  normalizePolicy,
  effectivePolicy,
  movePolicyKey,
  togglePolicyKey,
  policyKeyLabel,
  mixBugsEntry,
  mixBugsRatio,
  setMixBugs,
  applyPreset,
  formatAge,
  formatKnobValue,
  lastKnobWrites,
  lastNonZeroCap,
  claimRows,
  linkifyRefs,
} from '../dispatch.js';

function version(p: Partial<Version> & { id: string }): Version {
  return { mapId: 'm', name: p.id, description: null, status: 'planning', targetDate: null, sortOrder: 0, releasedAt: null, createdAt: '', ...p } as Version;
}
function node(p: Partial<Node> & { id: string }): Node {
  return { text: p.id, claimedBySession: null, claimedAt: null, ...p } as unknown as Node;
}
function ev(p: Partial<ChangeEvent>): ChangeEvent {
  return { id: 'e', mapId: 'm', nodeId: null, userId: null, eventType: 'map.field_changed', fieldName: 'maxActiveClaims', oldValue: null, newValue: null, createdAt: '2026-09-01T08:00:00Z', ...p };
}

const NOW = new Date('2026-09-01T12:00:00Z');
const V_MVP = version({ id: 'mvp', name: 'MVP Cutover', status: 'active', targetDate: '2026-09-15', sortOrder: 3 });
const V_OLD = version({ id: 'v15', name: 'V1.5', status: 'released', sortOrder: 2 });
const V_FU = version({ id: 'v15fu', name: 'V1.5 follow-up', status: 'planning', sortOrder: 4 });

describe('gateChips', () => {
  it('names the version with status + date, warns on released, flags unknown ids and entries', () => {
    const chips = gateChips(['version:mvp', 'version:v15', 'version:gone', 'type:bug', 'prio:P0'], [V_MVP, V_OLD]);
    expect(chips[0]).toMatchObject({ kind: 'version', label: 'MVP Cutover', detail: 'active · 2026-09-15', warning: null });
    expect(chips[1].warning).toMatch(/released/);
    expect(chips[2]).toMatchObject({ kind: 'unknown' });
    expect(chips[2].warning).toMatch(/No such version/);
    expect(chips[3]).toMatchObject({ kind: 'bugs', label: 'Bugs only' });
    expect(chips[4]).toMatchObject({ kind: 'unknown', label: 'prio:P0' });
  });
});

describe('gate + policy editing', () => {
  it('toggleGateEntry adds once and removes', () => {
    expect(toggleGateEntry([], 'type:bug')).toEqual(['type:bug']);
    expect(toggleGateEntry(['type:bug'], 'type:bug')).toEqual([]);
    expect(toggleGateEntry(['version:mvp'], 'type:bug')).toEqual(['version:mvp', 'type:bug']);
  });

  it('versionGateOptions puts the active lane first and released last', () => {
    expect(versionGateOptions([V_OLD, V_FU, V_MVP]).map((v) => v.id)).toEqual(['mvp', 'v15fu', 'v15']);
  });

  it('normalizePolicy drops unknown keys and duplicates; empty means default', () => {
    expect(normalizePolicy(['size', 'nope', 'size', 'bugs'])).toEqual(['size', 'bugs']);
    expect(effectivePolicy([])).toEqual(['bugs', 'priority', 'age']);
    expect(effectivePolicy(['age'])).toEqual(['age']);
  });

  it('movePolicyKey swaps neighbours and clamps at the ends', () => {
    expect(movePolicyKey(['bugs', 'size', 'age'], 'size', -1)).toEqual(['size', 'bugs', 'age']);
    expect(movePolicyKey(['bugs', 'size', 'age'], 'age', 1)).toEqual(['bugs', 'size', 'age']);
    expect(movePolicyKey(['bugs'], 'missing', 1)).toEqual(['bugs']);
  });
});

describe('mix:bugs policy entry (UI helpers)', () => {
  it('normalizePolicy keeps one valid mix entry in place, drops invalid shapes and duplicates', () => {
    expect(normalizePolicy(['priority', 'mix:bugs=40', 'age'])).toEqual(['priority', 'mix:bugs=40', 'age']);
    expect(normalizePolicy(['mix:bugs=101', 'age'])).toEqual(['age']);
    expect(normalizePolicy(['mix:bugs=x', 'mix:bugs='])).toEqual([]);
    expect(normalizePolicy(['mix:bugs=30', 'mix:bugs=60'])).toEqual(['mix:bugs=30']);
  });

  it('policyKeyLabel renders the mix entry readably', () => {
    expect(policyKeyLabel('mix:bugs=40')).toBe('Mix: 40 % Bugs');
    expect(policyKeyLabel('mix:bugs=0')).toBe('Mix: 0 % Bugs');
    expect(policyKeyLabel('bugs')).toBe('bugs first');
  });

  it('setMixBugs writes, replaces, clamps to 0–100, and removes the one entry', () => {
    expect(setMixBugs(['priority'], 40)).toEqual(['priority', 'mix:bugs=40']);
    expect(setMixBugs(['mix:bugs=40', 'age'], 55)).toEqual(['age', 'mix:bugs=55']);
    expect(setMixBugs(['mix:bugs=40', 'age'], null)).toEqual(['age']);
    expect(setMixBugs([], 140)).toEqual(['mix:bugs=100']);
    expect(setMixBugs([], -3)).toEqual(['mix:bugs=0']);
    expect(setMixBugs([], 37.4)).toEqual(['mix:bugs=37']);
    expect(mixBugsEntry(40)).toBe('mix:bugs=40');
  });

  it('mixBugsRatio reads the entry back (round trip with setMixBugs)', () => {
    expect(mixBugsRatio(setMixBugs(['priority', 'age'], 35))).toBe(35);
    expect(mixBugsRatio(['priority', 'age'])).toBeNull();
  });

  it('toggle and move neither swallow nor duplicate the mix entry', () => {
    expect(togglePolicyKey(['mix:bugs=40'], 'age')).toEqual(['mix:bugs=40', 'age']);
    expect(togglePolicyKey(['mix:bugs=40', 'age'], 'mix:bugs=40')).toEqual(['age']);
    expect(movePolicyKey(['bugs', 'mix:bugs=40'], 'mix:bugs=40', -1)).toEqual(['mix:bugs=40', 'bugs']);
    expect(normalizePolicy(togglePolicyKey(['mix:bugs=40', 'age'], 'size'))).toEqual(['mix:bugs=40', 'age', 'size']);
  });

  it('formatKnobValue renders the audit line readably', () => {
    expect(formatKnobValue('dispatchPolicy', ['priority', 'age', 'mix:bugs=40'], [])).toBe('priority › age › Mix: 40 % Bugs');
  });
});

describe('applyPreset', () => {
  it('release push needs a version and sets gate + drain policy, never a cap', () => {
    expect(applyPreset('release_push', null)).toBeNull();
    expect(applyPreset('release_push', 'mvp')).toEqual({ gate: ['version:mvp'], policy: ['bugs', 'size', 'priority', 'age'] });
  });
  it('bug sweep fences to bugs from any version', () => {
    expect(applyPreset('bug_sweep', null)).toEqual({ gate: ['type:bug'], policy: ['priority', 'age'] });
  });
});

describe('formatting', () => {
  it('formatAge rounds to the coarsest useful unit', () => {
    expect(formatAge(null, NOW)).toBe('—');
    expect(formatAge('2026-09-01T11:48:00Z', NOW)).toBe('12m');
    expect(formatAge('2026-09-01T08:00:00Z', NOW)).toBe('4h');
    expect(formatAge('2026-08-28T08:00:00Z', NOW)).toBe('4d');
    expect(formatAge('2026-09-01T12:00:00.400Z', NOW)).toBe('0m');
    expect(formatAge('not a date', NOW)).toBe('—');
  });

  it('formatKnobValue speaks the UI vocabulary', () => {
    expect(formatKnobValue('maxActiveClaims', 0, [])).toBe('0 (hold)');
    expect(formatKnobValue('maxActiveClaims', 12, [])).toBe('12');
    expect(formatKnobValue('dispatchGate', [], [])).toBe('open');
    expect(formatKnobValue('dispatchGate', ['version:mvp', 'type:bug'], [V_MVP])).toBe('MVP Cutover + Bugs only');
    expect(formatKnobValue('dispatchPolicy', [], [])).toBe('default (bugs › priority › age)');
    expect(formatKnobValue('dispatchPolicy', ['size', 'age'], [])).toBe('size › age');
  });
});

describe('audit trail', () => {
  const members: MapMember[] = [{ userId: 'u-dan', name: 'Dan', email: 'd@x', permission: 'admin' }];
  const events = [
    ev({ id: '1', fieldName: 'maxActiveClaims', oldValue: 6, newValue: 0, userId: 'u-dan', createdAt: '2026-09-01T09:00:00Z' }),
    ev({ id: '2', fieldName: 'maxActiveClaims', oldValue: 0, newValue: 6, userId: 'u-orch', createdAt: '2026-08-30T09:00:00Z' }),
    ev({ id: '3', fieldName: 'dispatchPolicy', oldValue: [], newValue: ['bugs', 'size'], userId: 'u-orch', createdAt: '2026-08-31T09:00:00Z' }),
    ev({ id: '4', eventType: 'node.field_changed', fieldName: 'maxActiveClaims', newValue: 99, createdAt: '2026-09-01T11:00:00Z' }),
    ev({ id: '5', fieldName: 'wipLimit', newValue: 10, createdAt: '2026-09-01T11:30:00Z' }),
  ];

  it('lastKnobWrites keeps the newest write per knob and resolves member names', () => {
    const w = lastKnobWrites(events, members);
    expect(w.maxActiveClaims).toMatchObject({ oldValue: 6, newValue: 0, actor: 'Dan', at: '2026-09-01T09:00:00Z' });
    expect(w.dispatchPolicy).toMatchObject({ newValue: ['bugs', 'size'], actor: null });
    expect(w.dispatchGate).toBeUndefined();
  });

  it('lastNonZeroCap looks through hold writes and never invents a number', () => {
    expect(lastNonZeroCap(events)).toBe(6);
    expect(lastNonZeroCap([ev({ oldValue: 0, newValue: 0 })])).toBeNull();
    expect(lastNonZeroCap([])).toBeNull();
  });
});

describe('claimRows', () => {
  it('lists claimed nodes oldest first and flags the ones past the sweeper threshold', () => {
    const nodes = {
      a: node({ id: 'a', claimedBySession: 'njoerd:worker-1:default', claimedAt: '2026-09-01T11:30:00Z' }),
      b: node({ id: 'b', claimedBySession: 'sat2:worker-3:default', claimedAt: '2026-09-01T06:00:00Z' }),
      c: node({ id: 'c' }),
      d: node({ id: 'd', claimedBySession: 'x', claimedAt: null }),
    };
    const rows = claimRows(nodes, NOW);
    expect(rows.map((r) => r.node.id)).toEqual(['b', 'a', 'd']);
    expect(rows[0].stale).toBe(true);
    expect(rows[1].stale).toBe(false);
    expect(rows[2]).toMatchObject({ ageHours: null, stale: false });
  });
});

describe('linkifyRefs', () => {
  it('turns #NNNN into repo links and leaves the rest as text', () => {
    const segs = linkifyRefs('waiting on PR #8770 and #8841', { owner: 'FulcrumCRM', name: 'crm' });
    expect(segs).toEqual([
      { text: 'waiting on PR ' },
      { ref: '#8770', url: 'https://github.com/FulcrumCRM/crm/issues/8770' },
      { text: ' and ' },
      { ref: '#8841', url: 'https://github.com/FulcrumCRM/crm/issues/8841' },
    ]);
  });
  it('is a no-op without a repo or without refs', () => {
    expect(linkifyRefs('needs a decision', { owner: 'o', name: 'r' })).toEqual([{ text: 'needs a decision' }]);
    expect(linkifyRefs('see #123', null)).toEqual([{ text: 'see #123' }]);
  });
});
