import { describe, it, expect, vi } from 'vitest';
import { syncHomeWidget, type HomeWidgetPlugin } from '../homeWidget.js';

function fakeWidget(userId: string | null) {
  return {
    status: vi.fn(async () => ({ userId })),
    signIn: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
  } satisfies HomeWidgetPlugin;
}

const deps = () => ({ mintToken: vi.fn(async () => ({ token: 'long-lived' })), origin: 'https://mb.example.com' });

describe('syncHomeWidget (#589)', () => {
  it('hands a freshly minted token to a widget that is not signed in as this user', async () => {
    const widget = fakeWidget(null);
    const d = deps();
    await syncHomeWidget(widget, 'u1', true, d);
    expect(d.mintToken).toHaveBeenCalledOnce();
    expect(widget.signIn).toHaveBeenCalledWith({ serverUrl: 'https://mb.example.com', token: 'long-lived', userId: 'u1' });
  });

  it('mints nothing when the widget already holds this user', async () => {
    const widget = fakeWidget('u1');
    const d = deps();
    await syncHomeWidget(widget, 'u1', true, d);
    expect(d.mintToken).not.toHaveBeenCalled();
    expect(widget.signIn).not.toHaveBeenCalled();
  });

  it('re-signs the widget when another user signs in', async () => {
    const widget = fakeWidget('u1');
    await syncHomeWidget(widget, 'u2', true, deps());
    expect(widget.signIn).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u2' }));
  });

  it('signs the widget out on sign-out, but not while a stored session is still being checked', async () => {
    const widget = fakeWidget('u1');
    await syncHomeWidget(widget, null, true, deps());
    expect(widget.signOut).not.toHaveBeenCalled();
    await syncHomeWidget(widget, null, false, deps());
    expect(widget.signOut).toHaveBeenCalledOnce();
  });
});
