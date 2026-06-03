/**
 * Tests for the auto-backfill drift remediation sweep.
 *
 * `runAutoBackfill` takes a `DriftReport[]` (the output of the daily
 * audit) and decides per-map whether to:
 *   - heal (call `backfillMap`),
 *   - skip (drift over the per-day cap),
 *   - record a failure (backfillMap threw or imported 0 of N).
 *
 * We mock `backfillMap` directly so each test can script its return
 * value / throw, without exercising the DB + GitHub stack.
 *
 * `runDriftAudit` (the end-to-end wrapper that calls audit → backfill →
 * Kuma push) is tested separately in `driftAudit.test.ts` follow-up
 * cases — here we only exercise the pure orchestration.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock backfillMap ──────────────────────────────────────────────

type BackfillReturn = { imported: number; total: number; capped: boolean; errored: number };
const backfillCalls: Array<{ mapId: string; opts: { maxToImport?: number; allowClosedWithinDays?: number } }> = [];
const backfillByMap = new Map<string, BackfillReturn | Error>();

vi.mock('../githubIngest.js', () => ({
  backfillMap: async (
    mapId: string,
    opts: { maxToImport?: number; allowClosedWithinDays?: number },
  ): Promise<BackfillReturn> => {
    backfillCalls.push({ mapId, opts });
    const programmed = backfillByMap.get(mapId);
    if (programmed instanceof Error) throw programmed;
    if (!programmed) {
      // Default: heal everything requested (1:1 with maxToImport).
      const requested = opts.maxToImport ?? 0;
      return { imported: requested, total: requested, capped: false, errored: 0 };
    }
    return programmed;
  },
}));

// ── SUT import (after mocks) ──────────────────────────────────────

import { runAutoBackfill, getAutoBackfillCap } from '../autoBackfill.js';
import type { DriftReport } from '../driftAudit.js';

// ── Fixtures ──────────────────────────────────────────────────────

function driftReport(mapId: string, onlyInGitHub: number, mapName?: string): DriftReport {
  return {
    mapId,
    mapName: mapName ?? `Map ${mapId}`,
    repo: 'owner/repo',
    onlyInGitHub,
    exampleIssues: Array.from({ length: Math.min(5, onlyInGitHub) }, (_, i) => i + 1),
  };
}

beforeEach(() => {
  backfillCalls.length = 0;
  backfillByMap.clear();
  delete process.env.AUTO_BACKFILL_MAX_PER_DAY;
});

// ── Cap parsing ───────────────────────────────────────────────────

describe('getAutoBackfillCap', () => {
  it('defaults to 50 when env var is unset', () => {
    delete process.env.AUTO_BACKFILL_MAX_PER_DAY;
    expect(getAutoBackfillCap()).toBe(50);
  });

  it('parses a positive integer', () => {
    process.env.AUTO_BACKFILL_MAX_PER_DAY = '12';
    expect(getAutoBackfillCap()).toBe(12);
  });

  it('clamps negative values to 0 (kill-switch)', () => {
    process.env.AUTO_BACKFILL_MAX_PER_DAY = '-5';
    expect(getAutoBackfillCap()).toBe(0);
  });

  it('falls back to default when the value is non-numeric', () => {
    process.env.AUTO_BACKFILL_MAX_PER_DAY = 'banana';
    expect(getAutoBackfillCap()).toBe(50);
  });

  it('0 is recognised as the kill switch', () => {
    process.env.AUTO_BACKFILL_MAX_PER_DAY = '0';
    expect(getAutoBackfillCap()).toBe(0);
  });
});

// ── Orchestration ─────────────────────────────────────────────────

describe('runAutoBackfill', () => {
  it('case 1: drift under cap → backfill called, imported=N, all healed', async () => {
    const reports = [driftReport('m1', 3, 'Roadmap')];
    const summary = await runAutoBackfill(reports, /* cap */ 50);

    expect(backfillCalls).toHaveLength(1);
    expect(backfillCalls[0].mapId).toBe('m1');
    expect(backfillCalls[0].opts.maxToImport).toBe(3);
    // Drift audit is open-only, so backfill must NOT widen to closed
    // issues — that would sweep in unrelated stale tickets.
    expect(backfillCalls[0].opts.allowClosedWithinDays).toBe(0);

    expect(summary.totalImported).toBe(3);
    expect(summary.totalManualPending).toBe(0);
    expect(summary.outcomes).toEqual([
      { mapId: 'm1', mapName: 'Roadmap', kind: 'healed', imported: 3 },
    ]);
  });

  it('case 2: drift over cap → backfill NOT called, recorded as over-cap', async () => {
    const reports = [driftReport('m1', 75, 'Big Drift')];
    const summary = await runAutoBackfill(reports, /* cap */ 50);

    expect(backfillCalls).toHaveLength(0);
    expect(summary.totalImported).toBe(0);
    expect(summary.totalManualPending).toBe(75);
    expect(summary.outcomes).toEqual([
      { mapId: 'm1', mapName: 'Big Drift', kind: 'over-cap', pending: 75 },
    ]);
  });

  it('case 3: mixed reports → per-map outcome split', async () => {
    const reports = [
      driftReport('mUnder', 4, 'Under'),
      driftReport('mOver', 100, 'Over'),
    ];
    const summary = await runAutoBackfill(reports, /* cap */ 50);

    // Only the under-cap map should have called backfill.
    expect(backfillCalls.map((c) => c.mapId)).toEqual(['mUnder']);

    expect(summary.totalImported).toBe(4);
    expect(summary.totalManualPending).toBe(100);

    const byId = new Map(summary.outcomes.map((o) => [o.mapId, o]));
    expect(byId.get('mUnder')).toEqual({
      mapId: 'mUnder',
      mapName: 'Under',
      kind: 'healed',
      imported: 4,
    });
    expect(byId.get('mOver')).toEqual({
      mapId: 'mOver',
      mapName: 'Over',
      kind: 'over-cap',
      pending: 100,
    });
  });

  it('case 4: backfill throws → outcome=failed, drift counted as manual-pending', async () => {
    backfillByMap.set('m1', new Error('install token revoked'));
    const reports = [driftReport('m1', 3, 'Failing')];

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const summary = await runAutoBackfill(reports, /* cap */ 50);
    warnSpy.mockRestore();

    expect(summary.totalImported).toBe(0);
    expect(summary.totalManualPending).toBe(3);
    expect(summary.outcomes).toEqual([
      {
        mapId: 'm1',
        mapName: 'Failing',
        kind: 'failed',
        pending: 3,
        reason: 'install token revoked',
      },
    ]);
  });

  it('case 5: cap=0 (kill switch) → no backfill ever, everything queued for manual', async () => {
    const reports = [
      driftReport('mA', 2),
      driftReport('mB', 5),
    ];
    const summary = await runAutoBackfill(reports, /* cap */ 0);

    expect(backfillCalls).toHaveLength(0);
    expect(summary.totalImported).toBe(0);
    expect(summary.totalManualPending).toBe(7);
    expect(summary.outcomes.every((o) => o.kind === 'over-cap')).toBe(true);
  });

  it('case 5b: AUTO_BACKFILL_MAX_PER_DAY=0 env var triggers kill switch when no cap override', async () => {
    process.env.AUTO_BACKFILL_MAX_PER_DAY = '0';
    const reports = [driftReport('m1', 3)];

    const summary = await runAutoBackfill(reports);
    expect(backfillCalls).toHaveLength(0);
    expect(summary.totalImported).toBe(0);
    expect(summary.totalManualPending).toBe(3);
  });

  it('partial heal (imported < onlyInGitHub but > 0) → counted as healed for what worked, manual-pending for the rest', async () => {
    // backfillMap returned imported=2 even though we asked for 3 — some
    // issues got skipped (skipped_exists, races, etc.). The orchestrator
    // should mark this as healed (2 created) AND record 1 manual.
    backfillByMap.set('m1', { imported: 2, total: 3, capped: false, errored: 0 });
    const reports = [driftReport('m1', 3, 'Partial')];

    const summary = await runAutoBackfill(reports, /* cap */ 50);
    expect(summary.totalImported).toBe(2);
    expect(summary.totalManualPending).toBe(1);
    expect(summary.outcomes).toEqual([
      { mapId: 'm1', mapName: 'Partial', kind: 'healed', imported: 2 },
    ]);
  });

  it('imported=0 of N (no exception, just nothing ingested) → marked failed, not healed', async () => {
    // Worst-case: backfillMap returned cleanly but imported zero. The
    // most likely cause is that every candidate raced with another
    // ingest path (skipped_exists) — that's still drift-relative-to-the-
    // audit-snapshot until next tick.
    backfillByMap.set('m1', { imported: 0, total: 3, capped: false, errored: 0 });
    const reports = [driftReport('m1', 3, 'Zero')];

    const summary = await runAutoBackfill(reports, /* cap */ 50);
    expect(summary.totalImported).toBe(0);
    expect(summary.totalManualPending).toBe(3);
    expect(summary.outcomes[0].kind).toBe('failed');
  });
});
