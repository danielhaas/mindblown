import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useToasts, showToast, dismissToast, TOAST_MS } from '../toast.js';

describe('toasts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useToasts.setState({ toasts: [] });
  });
  afterEach(() => vi.useRealTimers());

  it('shows a toast and removes it after TOAST_MS', () => {
    showToast('Created «A»');
    expect(useToasts.getState().toasts.map((t) => t.text)).toEqual(['Created «A»']);
    vi.advanceTimersByTime(TOAST_MS - 1);
    expect(useToasts.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(useToasts.getState().toasts).toHaveLength(0);
  });

  it('keeps only the newest three', () => {
    for (const n of ['a', 'b', 'c', 'd']) showToast(n);
    expect(useToasts.getState().toasts.map((t) => t.text)).toEqual(['b', 'c', 'd']);
  });

  it('dismisses one toast by id and keeps the link', () => {
    const a = showToast('a', 'https://example.test/issues/1');
    showToast('b');
    dismissToast(a);
    expect(useToasts.getState().toasts.map((t) => t.text)).toEqual(['b']);
    const c = showToast('c', 'https://example.test/issues/2');
    expect(useToasts.getState().toasts.find((t) => t.id === c)?.href).toBe('https://example.test/issues/2');
  });
});
