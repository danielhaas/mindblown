import { create } from 'zustand';

// Short confirmations after an action closes its window (#570): "Created «X»
// — filed issue #N". One line each, gone after a few seconds; the newest
// few stay on screen. Warnings stay in the window that caused them.

export const TOAST_MS = 5000;
const MAX_TOASTS = 3;

export interface Toast {
  id: number;
  text: string;
  /** Optional link, e.g. the issue that was filed. */
  href?: string;
}

interface ToastState {
  toasts: Toast[];
}

export const useToasts = create<ToastState>(() => ({ toasts: [] }));

let nextId = 1;

export function showToast(text: string, href?: string): number {
  const id = nextId++;
  const toast: Toast = href ? { id, text, href } : { id, text };
  useToasts.setState((s) => ({ toasts: [...s.toasts, toast].slice(-MAX_TOASTS) }));
  setTimeout(() => dismissToast(id), TOAST_MS);
  return id;
}

export function dismissToast(id: number): void {
  useToasts.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}
