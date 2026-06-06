import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

const MOBILE_KEY = 'mb_mobile_override';

function decideMobile(): boolean {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  if (params.get('m') === '1') {
    try {
      localStorage.setItem(MOBILE_KEY, '1');
    } catch {}
    return true;
  }
  if (params.get('d') === '1') {
    try {
      localStorage.setItem(MOBILE_KEY, '0');
    } catch {}
    return false;
  }
  try {
    const override = localStorage.getItem(MOBILE_KEY);
    if (override === '1') return true;
    if (override === '0') return false;
  } catch {}
  return window.matchMedia('(max-width: 768px)').matches;
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // SW registration failure is non-fatal; the app still works.
    });
  });
}

const mobile = decideMobile();

const load = mobile
  ? import('./mobile/MobileApp.js').then((m) => m.MobileApp)
  : import('./App.js').then((m) => m.App);

void load.then((Component) => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Component />
    </StrictMode>,
  );
});
