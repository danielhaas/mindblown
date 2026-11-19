import { create } from 'zustand';

// Short confirmations after an action closes its window (#570): "Created «X»
// — filed issue #N". One line each, gone after a few seconds; the newest
// few stay on screen. Warnings stay in the window that caused them.

export const TOAST_MS = 5000;
const MAX_TOASTS = 3;

/** A toast that offers one action stays this long — time to read and click. */
export const ACTION_TOAST_MS = 15000;

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: number;
  text: string;
  /** Optional link, e.g. the issue that was filed. */
  href?: string;
  /** Optional button, e.g. "Move" on a ticket filed in the wrong map. */
  action?: ToastAction;
  /** Shown in amber instead of green: something wants a look. */
  warn?: boolean;
}

interface ToastState {
  toasts: Toast[];
}

export const useToasts = create<ToastState>(() => ({ toasts: [] }));

let nextId = 1;

export function showToast(text: string, href?: string, opts: { action?: ToastAction; warn?: boolean } = {}): number {
  const id = nextId++;
  const toast: Toast = { id, text, ...(href ? { href } : {}), ...(opts.action ? { action: opts.action } : {}), ...(opts.warn ? { warn: true } : {}) };
  useToasts.setState((s) => ({ toasts: [...s.toasts, toast].slice(-MAX_TOASTS) }));
  setTimeout(() => dismissToast(id), opts.action ? ACTION_TOAST_MS : TOAST_MS);
  return id;
}

export function dismissToast(id: number): void {
  useToasts.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}
