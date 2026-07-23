import { describe, it, expect } from 'vitest';
import type { StatusDef } from '@mindblown/core';
import { computeWorkStartStatus } from '../workStartSync.js';

const DEFAULT_WORKFLOW: StatusDef[] = [
  { id: 'todo', name: 'Todo', category: 'todo', color: '#9ca3af', position: 0 },
  { id: 'in_progress', name: 'In Progress', category: 'in_progress', color: '#3b82f6', position: 1 },
  { id: 'done', name: 'Done', category: 'done', color: '#22c55e', position: 2 },
];

describe('computeWorkStartStatus', () => {
  it('transitions a null-status node to in_progress', () => {
    expect(computeWorkStartStatus(null, null, DEFAULT_WORKFLOW)).toBe('in_progress');
  });

  it('transitions a todo-category node to in_progress', () => {
    expect(computeWorkStartStatus('todo', 0, DEFAULT_WORKFLOW)).toBe('in_progress');
  });

  it('matches todo by display name, case-insensitive', () => {
    expect(computeWorkStartStatus('Todo', null, DEFAULT_WORKFLOW)).toBe('in_progress');
  });

  it('leaves an already-in-progress node alone', () => {
    expect(computeWorkStartStatus('in_progress', 30, DEFAULT_WORKFLOW)).toBeNull();
  });

  it('leaves a done node alone', () => {
    expect(computeWorkStartStatus('done', null, DEFAULT_WORKFLOW)).toBeNull();
  });

  it('leaves a done-by-progress node alone even with a stale status', () => {
    expect(computeWorkStartStatus('todo', 100, DEFAULT_WORKFLOW)).toBeNull();
    expect(computeWorkStartStatus(null, 100, DEFAULT_WORKFLOW)).toBeNull();
  });

  it('does not clobber an unrecognized custom status string', () => {
    expect(computeWorkStartStatus('waiting-on-legal', 10, DEFAULT_WORKFLOW)).toBeNull();
  });

  it('picks the lowest-position in_progress status in a custom workflow', () => {
    const custom: StatusDef[] = [
      { id: 'backlog', name: 'Backlog', category: 'todo', color: '#999', position: 0 },
      { id: 'review', name: 'In Review', category: 'in_progress', color: '#f90', position: 2 },
      { id: 'doing', name: 'Doing', category: 'in_progress', color: '#39f', position: 1 },
      { id: 'shipped', name: 'Shipped', category: 'done', color: '#2c5', position: 3 },
    ];
    expect(computeWorkStartStatus('backlog', null, custom)).toBe('doing');
  });

  it('does not downgrade a custom in_progress state (In Review stays)', () => {
    const custom: StatusDef[] = [
      { id: 'doing', name: 'Doing', category: 'in_progress', color: '#39f', position: 0 },
      { id: 'review', name: 'In Review', category: 'in_progress', color: '#f90', position: 1 },
    ];
    expect(computeWorkStartStatus('review', 60, custom)).toBeNull();
  });

  it('falls back to the in_progress literal when the workflow has no in_progress entry', () => {
    const odd: StatusDef[] = [
      { id: 'open', name: 'Open', category: 'todo', color: '#999', position: 0 },
      { id: 'closed', name: 'Closed', category: 'done', color: '#2c5', position: 1 },
    ];
    expect(computeWorkStartStatus('open', null, odd)).toBe('in_progress');
    expect(computeWorkStartStatus(null, null, [])).toBe('in_progress');
  });
});
