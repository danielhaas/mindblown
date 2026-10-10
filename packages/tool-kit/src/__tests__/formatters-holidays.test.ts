/**
 * get_map names the holiday calendar a map schedules with (#110) — agents
 * only see the tool-kit surface, so a working calendar must show there.
 */
import { describe, it, expect } from 'vitest';
import { formatMapTree } from '../formatters.js';
import type { MapDetail } from '../types.js';

function detail(map: Partial<MapDetail['map']>): MapDetail {
  return {
    map: {
      id: 'm1',
      workspaceId: 'ws1',
      name: 'Test Map',
      description: null,
      rootNodeId: 'root',
      effortUnit: 'days',
      healthThreshold: 0.2,
      computedProgress: 0,
      healthSignal: 'on_track',
      createdAt: '2026-06-10T10:00:00Z',
      updatedAt: '2026-06-10T10:00:00Z',
      statusWorkflow: [],
      baselines: [],
      wipLimit: null,
      ...map,
    } as MapDetail['map'],
    nodes: [],
  };
}

describe('formatMapTree — holiday calendar (#110)', () => {
  it('says nothing when every day counts', () => {
    expect(formatMapTree(detail({ holidayJurisdiction: null, holidayOverrides: { add: [], remove: [] } }))).not.toContain('Calendar:');
  });

  it('names the jurisdiction and the overrides', () => {
    const out = formatMapTree(
      detail({ holidayJurisdiction: 'LI', holidayOverrides: { add: ['2026-12-24', '2026-12-31'], remove: ['2026-12-08'] } }),
    );
    expect(out).toContain('Calendar: working days (Mon–Fri) — LI public holidays, +2 own day(s) off, 1 holiday(s) worked skipped in schedule dates');
  });

  it('own days off alone are a working calendar too', () => {
    expect(formatMapTree(detail({ holidayOverrides: { add: ['2026-12-31'], remove: [] } }))).toContain('Calendar: working days (Mon–Fri) — +1 own day(s) off');
  });
});
