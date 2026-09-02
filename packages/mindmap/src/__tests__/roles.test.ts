import { describe, it, expect } from 'vitest';
import {
  ALL_PANELS,
  ALL_VIEWS,
  DEFAULT_ROLE,
  ROLE_CONFIG,
  ROLE_ORDER,
  VIEW_ROLE_STORAGE_KEY,
  defaultViewForRole,
  isPanelVisible,
  isTabVisible,
  pickCurrentCycle,
  readStoredRole,
  reconcileView,
  writeStoredRole,
} from '../roles.js';

function memStorage(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  };
}

describe('ROLE_CONFIG invariants', () => {
  it('every role lists only real views and panels, at least one tab', () => {
    for (const role of ROLE_ORDER) {
      const cfg = ROLE_CONFIG[role];
      expect(cfg.tabs.length).toBeGreaterThan(0);
      for (const t of cfg.tabs) expect(ALL_VIEWS).toContain(t);
      for (const p of cfg.panels) expect(ALL_PANELS).toContain(p);
    }
  });

  it('"all" is the escape hatch: shows everything', () => {
    expect(ROLE_CONFIG.all.tabs).toEqual(ALL_VIEWS);
    expect(ROLE_CONFIG.all.panels).toEqual(ALL_PANELS);
    expect(DEFAULT_ROLE).toBe('all');
  });

  it('persona Round 1 outcomes are encoded', () => {
    // Gantt / Hill / Workload were dropped by all three personas
    for (const role of ['stakeholder', 'pm', 'developer'] as const) {
      expect(isTabVisible(role, 'gantt')).toBe(false);
      expect(isTabVisible(role, 'hill')).toBe(false);
      expect(isTabVisible(role, 'workload')).toBe(false);
    }
    // Developer wanted List, not Kanban, as the default
    expect(defaultViewForRole('developer')).toBe('list');
    // Stakeholder: digest landing page + Releases, no panels (Round 2)
    expect(ROLE_CONFIG.stakeholder.tabs).toEqual(['digest', 'releases']);
    expect(defaultViewForRole('pm')).toBe('cockpit');
    expect(ROLE_CONFIG.stakeholder.panels).toEqual(['property']);
    expect(isPanelVisible('stakeholder', 'triage')).toBe(false);
    expect(isPanelVisible('pm', 'triage')).toBe(true);
    // "all" keeps today's default
    expect(defaultViewForRole('all')).toBe('mindmap');
  });

  it('Fleet tab: PM and developer see it (dev read-only in the view), stakeholder does not', () => {
    expect(isTabVisible('pm', 'fleet')).toBe(true);
    expect(isTabVisible('developer', 'fleet')).toBe(true);
    expect(isTabVisible('stakeholder', 'fleet')).toBe(false);
    // List stays the developer landing page — Fleet is appended, not the default
    expect(defaultViewForRole('developer')).toBe('list');
  });
});

describe('reconcileView', () => {
  it('keeps the current view when the role still shows it', () => {
    expect(reconcileView('pm', 'kanban')).toBe('kanban');
  });
  it('falls back to the role default when it does not', () => {
    expect(reconcileView('stakeholder', 'kanban')).toBe('digest');
  });
});

describe('persistence', () => {
  it('round-trips and ignores garbage', () => {
    const s = memStorage();
    writeStoredRole('pm', s);
    expect(s.getItem(VIEW_ROLE_STORAGE_KEY)).toBe('pm');
    expect(readStoredRole(s)).toBe('pm');
    expect(readStoredRole(memStorage({ [VIEW_ROLE_STORAGE_KEY]: 'ceo' }))).toBe('all');
    expect(readStoredRole(memStorage({ [VIEW_ROLE_STORAGE_KEY]: 'constructor' }))).toBe('all');
    expect(readStoredRole(undefined)).toBe('all');
  });
});

describe('pickCurrentCycle', () => {
  const c = (id: string, start: string, end: string, status = 'planned') => ({ id, startDate: start, endDate: end, status });
  it('prefers the sprint whose dates contain today, even if still "planned"', () => {
    const cycles = [c('old', '2026-08-01', '2026-08-10', 'active'), c('now', '2026-08-11', '2026-08-26')];
    expect(pickCurrentCycle(cycles, new Date('2026-08-26T10:00:00Z'))?.id).toBe('now');
  });
  it('prefers the most recently started sprint when cycles overlap (Round 2: leftover bucket vs Sprint 0)', () => {
    const cycles = [c('bucket', '2026-08-27', '2026-09-25'), c('sprint0', '2026-08-31', '2026-09-11')];
    expect(pickCurrentCycle(cycles, new Date('2026-08-28'))?.id).toBe('bucket');
    expect(pickCurrentCycle(cycles, new Date('2026-09-01'))?.id).toBe('sprint0');
  });
  it('falls back to the active sprint, then null', () => {
    expect(pickCurrentCycle([c('a', '2026-01-01', '2026-01-10', 'active')], new Date('2026-08-26'))?.id).toBe('a');
    expect(pickCurrentCycle([c('a', '2026-01-01', '2026-01-10')], new Date('2026-08-26'))).toBeNull();
  });
});
