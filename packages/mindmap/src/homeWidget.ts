import { useEffect } from 'react';
import { Capacitor, registerPlugin } from '@capacitor/core';
import * as api from './api.js';

/**
 * Sign-in hand-over to the Android home-screen widget (#589).
 *
 * In the Android app (packages/mobile) the widget fetches the board on its
 * own, in the background, so it needs a credential of its own: on sign-in
 * the web app mints a long-lived token once and hands it to the native
 * `MindBlownWidget` plugin together with this server's origin; on sign-out
 * it takes it back, and the widget shows "sign in". In a browser this is a
 * no-op.
 */
export interface HomeWidgetPlugin {
  status(): Promise<{ userId: string | null }>;
  signIn(opts: { serverUrl: string; token: string; userId: string }): Promise<void>;
  signOut(): Promise<void>;
}

const plugin = registerPlugin<HomeWidgetPlugin>('MindBlownWidget');

function nativeWidget(): HomeWidgetPlugin | null {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('MindBlownWidget') ? plugin : null;
}

/**
 * Bring the widget's sign-in in line with the app's. `hasSession` = a token
 * is stored (signed out is only "no user and no token" — at startup the user
 * is null while the stored token is still being checked).
 */
export async function syncHomeWidget(
  widget: HomeWidgetPlugin,
  userId: string | null,
  hasSession: boolean,
  deps: { mintToken: () => Promise<{ token: string }>; origin: string },
): Promise<void> {
  if (!userId) {
    if (!hasSession) await widget.signOut();
    return;
  }
  const { userId: widgetUser } = await widget.status();
  if (widgetUser === userId) return;
  const { token } = await deps.mintToken();
  await widget.signIn({ serverUrl: deps.origin, token, userId });
}

export function useHomeWidgetSync(userId: string | null): void {
  useEffect(() => {
    const widget = nativeWidget();
    if (!widget) return;
    syncHomeWidget(widget, userId, api.getToken() !== null, {
      mintToken: api.createLongLivedToken,
      origin: window.location.origin,
    }).catch(() => {
      // The widget keeps its last state; the next sign-in or start retries.
    });
  }, [userId]);
}
