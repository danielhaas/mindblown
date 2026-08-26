import { describe, it, expect } from 'vitest';
import {
  DEFAULT_DEPTH,
  DEFAULT_VIEW,
  EMPTY_URL_STATE,
  isNavChange,
  parseUrlState,
  resolveDepth,
  resolveView,
  serializeUrlState,
  validateUrlState,
  type UrlState,
  type UrlStateContext,
} from '../urlState.js';

function state(patch: Partial<UrlState> = {}): UrlState {
  return { ...EMPTY_URL_STATE, ...patch };
}

function ctx(patch: Partial<Record<keyof UrlStateContext, string[]>> = {}): UrlStateContext {
  return {
    nodeIds: new Set(patch.nodeIds ?? []),
    versionIds: new Set(patch.versionIds ?? []),
    sprintIds: new Set(patch.sprintIds ?? []),
    phaseIds: new Set(patch.phaseIds ?? []),
  };
}

describe('parseUrlState', () => {
  it('reads every mirrored param', () => {
    expect(
      parseUrlState('?map=m1&view=list&focus=n1&node=n2&depth=3&v=v1&s=s1&p=p1'),
    ).toEqual(
      state({
        map: 'm1',
        view: 'list',
        focus: 'n1',
        node: 'n2',
        depth: 3,
        version: 'v1',
        sprint: 's1',
        phase: 'p1',
      }),
    );
  });

  it('returns all-null for an empty query string', () => {
    expect(parseUrlState('')).toEqual(EMPTY_URL_STATE);
    expect(parseUrlState('?')).toEqual(EMPTY_URL_STATE);
  });

  it('ignores params it does not own', () => {
    expect(parseUrlState('?m=1&gh=connected&map=m1')).toEqual(state({ map: 'm1' }));
  });

  it('drops an unknown view rather than trusting it', () => {
    expect(parseUrlState('?view=nonsense').view).toBeNull();
  });

  it('accepts every view the switcher offers', () => {
    // A view missing from VIEW_IDS survives neither a reload nor a shared
    // link: it parses to null and silently resolves back to the mindmap.
    // Cheap to forget when adding a tab, invisible until someone shares one.
    for (const view of [
      'mindmap',
      'kanban',
      'gantt',
      'list',
      'calendar',
      'hill',
      'workload',
      'releases',
      'requirements',
      'guide',
      'digest',
      'cockpit',
    ]) {
      expect(parseUrlState(`?view=${view}`).view).toBe(view === 'mindmap' ? 'mindmap' : view);
    }
  });

  it('treats blank values as absent', () => {
    expect(parseUrlState('?map=&focus=%20')).toEqual(EMPTY_URL_STATE);
  });

  describe('depth', () => {
    it('keeps 0, which the store reads as unlimited', () => {
      expect(parseUrlState('?depth=0').depth).toBe(0);
    });

    it.each(['-1', '999', '1.5', 'abc', ''])('rejects %o', (raw) => {
      expect(parseUrlState(`?depth=${raw}`).depth).toBeNull();
    });
  });
});

describe('requirements release filter (rv / rvm)', () => {
  it('parses a version id and the exact mode', () => {
    expect(parseUrlState('?rv=v1&rvm=exact')).toEqual(
      state({ reqVersion: 'v1', reqVersionMode: 'exact' }),
    );
  });

  it('parses the "none" sentinel', () => {
    expect(parseUrlState('?rv=none').reqVersion).toBe('none');
  });

  it('drops an unknown rvm value rather than trusting it', () => {
    expect(parseUrlState('?rv=v1&rvm=sideways').reqVersionMode).toBeNull();
  });

  it('round-trips through serialize', () => {
    const original = state({ map: 'm1', reqVersion: 'v1', reqVersionMode: 'exact' });
    expect(parseUrlState(serializeUrlState('', original))).toEqual(original);
  });

  it('omits the mode without a selected release, and for "none"', () => {
    expect(serializeUrlState('', state({ reqVersionMode: 'exact' }))).toBe('');
    expect(serializeUrlState('', state({ reqVersion: 'none', reqVersionMode: 'exact' }))).toBe(
      '?rv=none',
    );
  });

  it('validate keeps a resolving id and the "none" sentinel', () => {
    const c = ctx({ versionIds: ['v1'] });
    expect(validateUrlState(state({ reqVersion: 'v1' }), c).reqVersion).toBe('v1');
    expect(validateUrlState(state({ reqVersion: 'none' }), c).reqVersion).toBe('none');
  });

  it('validate clears a deleted version instead of rendering an empty register', () => {
    expect(validateUrlState(state({ reqVersion: 'gone' }), ctx()).reqVersion).toBeNull();
  });

  it('is a lens change, not navigation', () => {
    expect(isNavChange(state(), state({ reqVersion: 'v1', reqVersionMode: 'exact' }))).toBe(false);
  });
});

describe('serializeUrlState', () => {
  it('round-trips through parse', () => {
    const original = state({
      map: 'm1',
      view: 'requirements',
      focus: 'n1',
      node: 'n2',
      depth: 0,
      version: 'v1',
      sprint: 's1',
      phase: 'p1',
    });
    expect(parseUrlState(serializeUrlState('', original))).toEqual(original);
  });

  it('omits defaults so the common case stays at ?map=<id>', () => {
    const search = serializeUrlState(
      '',
      state({ map: 'm1', view: DEFAULT_VIEW, depth: DEFAULT_DEPTH }),
    );
    expect(search).toBe('?map=m1&view=mindmap');
  });

  it('emits nothing when there is nothing to say', () => {
    expect(serializeUrlState('', EMPTY_URL_STATE)).toBe('');
  });

  it('preserves params it does not own', () => {
    const search = serializeUrlState('?m=1', state({ map: 'm1' }));
    expect(parseUrlState(search).map).toBe('m1');
    expect(new URLSearchParams(search).get('m')).toBe('1');
  });

  it('clears params that dropped out of the state', () => {
    const search = serializeUrlState('?map=m1&view=list&v=v1', state({ map: 'm1' }));
    expect(search).toBe('?map=m1');
  });

  it('is stable across repeated writes', () => {
    const s = state({ map: 'm1', view: 'kanban' });
    const once = serializeUrlState('', s);
    expect(serializeUrlState(once, s)).toBe(once);
  });
});

describe('validateUrlState', () => {
  const full = state({
    map: 'm1',
    view: 'list',
    focus: 'n1',
    node: 'n2',
    depth: 3,
    version: 'v1',
    sprint: 's1',
    phase: 'p1',
  });

  it('keeps references that resolve', () => {
    const resolved = validateUrlState(
      full,
      ctx({
        nodeIds: ['n1', 'n2'],
        versionIds: ['v1'],
        sprintIds: ['s1'],
        phaseIds: ['p1'],
      }),
    );
    expect(resolved).toEqual(full);
  });

  it('clears a stale filter instead of rendering an empty map', () => {
    const resolved = validateUrlState(full, ctx({ nodeIds: ['n1', 'n2'] }));
    expect(resolved.version).toBeNull();
    expect(resolved.sprint).toBeNull();
    expect(resolved.phase).toBeNull();
  });

  it('falls back to root when the focused node is gone', () => {
    expect(validateUrlState(full, ctx({ nodeIds: ['n2'] })).focus).toBeNull();
  });

  it('drops a selection pointing at a deleted node', () => {
    expect(validateUrlState(full, ctx({ nodeIds: ['n1'] })).node).toBeNull();
  });

  it('leaves map, view and depth alone', () => {
    const resolved = validateUrlState(full, ctx());
    expect(resolved.map).toBe('m1');
    expect(resolved.view).toBe('list');
    expect(resolved.depth).toBe(3);
  });
});

describe('resolve', () => {
  it('maps an absent view or depth onto the default', () => {
    expect(resolveView(null)).toBe(DEFAULT_VIEW);
    expect(resolveDepth(null)).toBe(DEFAULT_DEPTH);
  });

  it('lands a bare URL on the role default, but an explicit view always wins', () => {
    expect(resolveView(null, 'developer')).toBe('list');
    expect(resolveView(null, 'stakeholder')).toBe('digest');
    expect(resolveView('gantt', 'stakeholder')).toBe('gantt');
  });

  it('preserves depth 0 rather than treating it as absent', () => {
    expect(resolveDepth(0)).toBe(0);
  });
});

describe('isNavChange', () => {
  it('is true when the view changes', () => {
    expect(isNavChange(state({ view: 'list' }), state({ view: 'kanban' }))).toBe(true);
  });

  it.each<[string, Partial<UrlState>]>([
    ['map', { map: 'm2' }],
    ['focus', { focus: 'n9' }],
    ['node', { node: 'n9' }],
  ])('is true when %s changes', (_label, patch) => {
    expect(isNavChange(state(), state(patch))).toBe(true);
  });

  it.each<[string, Partial<UrlState>]>([
    ['depth', { depth: 4 }],
    ['version', { version: 'v1' }],
    ['sprint', { sprint: 's1' }],
    ['phase', { phase: 'p1' }],
  ])('is false when only %s changes', (_label, patch) => {
    expect(isNavChange(state(), state(patch))).toBe(false);
  });
});
