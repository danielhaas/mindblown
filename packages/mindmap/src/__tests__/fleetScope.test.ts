import { describe, it, expect } from 'vitest';
import { projectLabel, scopeTarget } from '../fleetScope.js';
import type { FleetScope } from '../fleetScope.js';

const names = new Map([['a', 'Alpha'], ['b', 'Beta']]);
const thisProject: FleetScope = { mapId: 'a', fleetId: 'f', all: false, mapNames: names };
const allProjects: FleetScope = { ...thisProject, all: true };
const fleetPage: FleetScope = { mapId: null, fleetId: 'f', all: true, mapNames: names };

describe('scopeTarget', () => {
  it('reads the map in "this project", the fleet in "all projects" and on the fleet page', () => {
    expect(scopeTarget(thisProject, 'a')).toEqual({ mapId: 'a' });
    expect(scopeTarget(allProjects, 'a')).toEqual({ fleetId: 'f' });
    expect(scopeTarget(fleetPage, null)).toEqual({ fleetId: 'f' });
  });

  it('falls back to the current map without a provider, and to the map when there is no fleet', () => {
    expect(scopeTarget(null, 'x')).toEqual({ mapId: 'x' });
    expect(scopeTarget(null, null)).toBeNull();
    expect(scopeTarget({ ...allProjects, fleetId: null }, 'a')).toEqual({ mapId: 'a' });
  });
});

describe('projectLabel', () => {
  it('labels another project by name, never this map, and nothing without a scope', () => {
    expect(projectLabel(thisProject, 'b')).toBe('Beta');
    expect(projectLabel(thisProject, 'a')).toBeNull();
    expect(projectLabel(allProjects, 'a')).toBeNull();
    expect(projectLabel(null, 'b')).toBeNull();
  });

  it('fleet-level rows say so only where they show up (all projects, fleet page)', () => {
    expect(projectLabel(allProjects, null)).toBe('fleet');
    expect(projectLabel(fleetPage, null)).toBe('fleet');
    expect(projectLabel(thisProject, null)).toBeNull();
  });

  it('labels every project on the fleet page; unknown data stays unlabelled', () => {
    expect(projectLabel(fleetPage, 'a')).toBe('Alpha');
    expect(projectLabel(fleetPage, 'zzz')).toBe('another project');
    expect(projectLabel(fleetPage, undefined)).toBeNull();
  });
});
