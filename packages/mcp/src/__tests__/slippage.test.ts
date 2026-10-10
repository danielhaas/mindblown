/**
 * status_digest's Slippage section (#321): honest without due dates.
 */
import { describe, it, expect } from 'vitest';
import { slippageLines } from '../formatters.js';
import type { ChangeEvent, ReleaseTrendRow } from '../api.js';

const NOW = new Date('2026-10-10T12:00:00Z');
const nodes = [
  { id: 'a', text: 'Login flow', effortEstimate: 3 },
  { id: 'b', text: 'Export', effortEstimate: 5 },
  { id: 'c', text: 'Search', effortEstimate: 2 },
];
const fmtNode = (n: { text: string }) => `**${n.text}**`;
const ev = (nodeId: string, fieldName: string, oldValue: unknown, newValue: unknown) =>
  ({ eventType: 'node.field_changed', nodeId, fieldName, oldValue, newValue }) as unknown as ChangeEvent;
const row = (p: Partial<ReleaseTrendRow>): ReleaseTrendRow => ({
  versionId: 'v1', versionName: 'V1', versionStatus: 'active', targetDate: '2026-12-01',
  remainingTickets: 10, velocityAdjustedFinishDate: '2026-11-20', plannedFinishDate: '2026-11-01', ...p,
});
const base = {
  events: [] as ChangeEvent[], nodes, sinceDays: 14, unit: 'days',
  completedEffort: 4, completedCount: 2, completedWithEstimate: 2, openLeaves: 5, fmtNode, now: NOW,
};

describe('slippageLines (#321)', () => {
  it('forecast movement since the window start, per open release', () => {
    const out = slippageLines({
      ...base,
      releaseRows: [
        row({ trend: { days: 14, fromDate: '2026-09-26', fromVelocityFinishDate: '2026-11-15', fromPlannedFinishDate: '2026-10-30', plannedFinishDeltaDays: 2, velocityFinishDeltaDays: 5 } }),
        row({ versionId: 'v2', versionName: 'V2', versionStatus: 'planning', trend: { days: 14, fromDate: '2026-09-26', fromVelocityFinishDate: null, fromPlannedFinishDate: null, plannedFinishDeltaDays: null, velocityFinishDeltaDays: -3 } }),
        row({ versionId: 'v3', versionName: 'V3', versionStatus: 'planning', evidence: { state: 'not_measurable', note: '' } }),
        row({ versionId: 'v4', versionName: 'Old', versionStatus: 'released' }),
      ],
    }).join('\n');
    expect(out).toContain('## Slippage since 2026-09-26');
    expect(out).toContain('🔴 **V1**: forecast 2026-11-20 slipped **+5d** since 2026-09-26 (was 2026-11-15), target 2026-12-01');
    expect(out).toContain('🟢 **V2**: forecast 2026-11-20 pulled in 3d since 2026-09-26');
    expect(out).toContain('**V3**: not started yet — no forecast verdict');
    expect(out).not.toContain('Old');
  });

  it('pulled into an active release, estimates grown, reopened — without any due date', () => {
    const out = slippageLines({
      ...base,
      releaseRows: [row({})],
      events: [ev('a', 'versionId', null, 'v1'), ev('b', 'effortEstimate', 2, 5), ev('c', 'percentComplete', 100, 40)],
    }).join('\n');
    expect(out).toContain('Pulled into an active release: 1 item(s), +3.00 days');
    expect(out).toContain('**Login flow** → V1');
    expect(out).toContain('Estimates grew: 1 item(s), +3.00 days');
    expect(out).toContain('Reopened after done: 1 item(s)');
  });

  it('a release without a velocity line reports the planned date it compares', () => {
    const out = slippageLines({
      ...base,
      releaseRows: [row({ velocityAdjustedFinishDate: null, trend: { days: 14, fromDate: '2026-09-26', fromVelocityFinishDate: null, fromPlannedFinishDate: '2026-10-28', plannedFinishDeltaDays: 4, velocityFinishDeltaDays: null } })],
    }).join('\n');
    expect(out).toContain('forecast 2026-11-01 slipped **+4d** since 2026-09-26 (was 2026-10-28)');
  });

  it('estimate growth is net per item (2 → 8 → 3 grew by 1)', () => {
    // newest first, as the change log returns them
    const out = slippageLines({ ...base, releaseRows: [], events: [ev('b', 'effortEstimate', 8, 3), ev('b', 'effortEstimate', 2, 8)] }).join('\n');
    expect(out).toContain('Estimates grew: 1 item(s), +1.00 days');
    const shrunk = slippageLines({ ...base, releaseRows: [], events: [ev('b', 'effortEstimate', 8, 1), ev('b', 'effortEstimate', 2, 8)] }).join('\n');
    expect(shrunk).not.toContain('Estimates grew');
  });

  it('the red line needs open work, and only blames estimates when none were set', () => {
    expect(slippageLines({ ...base, releaseRows: [], completedEffort: 0, completedCount: 0, openLeaves: 0 }).join('\n')).not.toContain('🔴');
    expect(slippageLines({ ...base, releaseRows: [], completedEffort: -2, completedCount: 3, completedWithEstimate: 1 }).join('\n'))
      .toContain('reopened work outweighs what was finished');
    expect(slippageLines({ ...base, releaseRows: [], eventsTruncated: true }).join('\n')).toContain('hit its row cap');
  });

  it('no estimated effort completed is a red line, not a footnote', () => {
    const none = slippageLines({ ...base, releaseRows: [], completedEffort: 0, completedCount: 9, completedWithEstimate: 0 }).join('\n');
    expect(none).toContain('🔴 **0 days of estimated effort completed in 14 days** — the 9 item(s) finished carry no estimate');
    expect(slippageLines({ ...base, releaseRows: [], completedEffort: 0, completedCount: 0 }).join('\n'))
      .toContain('🔴 **Nothing completed in 14 days**');
  });

  it('a quiet window says so', () => {
    expect(slippageLines({ ...base, releaseRows: [] })).toEqual([
      '## Slippage since 2026-09-26',
      '_No release forecast moved, nothing was pulled into an active release, no estimate grew._',
    ]);
  });
});
