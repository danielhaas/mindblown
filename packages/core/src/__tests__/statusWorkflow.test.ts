/**
 * Unit tests for the consolidated status-workflow helpers (#119).
 *
 * These mirror the inline test fixtures from packages/server that used
 * to live next to each duplicate implementation — they now have one
 * canonical home in core.
 */

import { describe, it, expect } from 'vitest';
import type { StatusDef } from '../types.js';
import {
  resolveStatusDef,
  buildIsDonePredicate,
  buildInProgressIds,
  buildTodoIds,
} from '../statusWorkflow.js';

const workflow: StatusDef[] = [
  { id: 'st-todo', name: 'Todo', category: 'todo', color: '#888', position: 0 },
  { id: 'st-wip', name: 'In Progress', category: 'in_progress', color: '#444', position: 1 },
  { id: 'st-done', name: 'Done', category: 'done', color: '#0a0', position: 2 },
];

describe('resolveStatusDef', () => {
  it('finds a def by exact id', () => {
    expect(resolveStatusDef(workflow, 'st-done')?.category).toBe('done');
  });

  it('finds a def by case-insensitive name', () => {
    expect(resolveStatusDef(workflow, 'done')?.id).toBe('st-done');
    expect(resolveStatusDef(workflow, 'DONE')?.id).toBe('st-done');
    expect(resolveStatusDef(workflow, 'IN PROGRESS')?.id).toBe('st-wip');
  });

  it('returns undefined for null/unknown keys', () => {
    expect(resolveStatusDef(workflow, null)).toBeUndefined();
    expect(resolveStatusDef(workflow, 'archived')).toBeUndefined();
  });
});

describe('buildIsDonePredicate', () => {
  const isDone = buildIsDonePredicate(workflow);

  it('returns true for done id and name (case-insensitive)', () => {
    expect(isDone('st-done')).toBe(true);
    expect(isDone('done')).toBe(true);
    expect(isDone('Done')).toBe(true);
  });

  it('returns false for null, todo, in_progress', () => {
    expect(isDone(null)).toBe(false);
    expect(isDone('st-todo')).toBe(false);
    expect(isDone('In Progress')).toBe(false);
  });

  it('returns false for unknown status strings (defensive)', () => {
    expect(isDone('archived')).toBe(false);
  });
});

describe('buildInProgressIds / buildTodoIds', () => {
  it('returns just the in_progress ids', () => {
    expect(buildInProgressIds(workflow)).toEqual(new Set(['st-wip']));
  });

  it('returns just the todo ids', () => {
    expect(buildTodoIds(workflow)).toEqual(new Set(['st-todo']));
  });

  it('handles a workflow with multiple defs in each category', () => {
    const wf: StatusDef[] = [
      { id: 'a', name: 'A', category: 'todo', color: '', position: 0 },
      { id: 'b', name: 'B', category: 'todo', color: '', position: 1 },
      { id: 'c', name: 'C', category: 'in_progress', color: '', position: 2 },
      { id: 'd', name: 'D', category: 'done', color: '', position: 3 },
    ];
    expect(buildTodoIds(wf)).toEqual(new Set(['a', 'b']));
    expect(buildInProgressIds(wf)).toEqual(new Set(['c']));
  });
});
