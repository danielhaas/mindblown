import type { CapacitorConfig } from '@capacitor/cli';

/**
 * The app is the live MindBlown server in a WebView: `server.url` points at
 * your deployment, so the APK never ships a stale copy of the UI and the
 * web app's same-origin `/api` calls just work. Set MINDBLOWN_URL when
 * syncing (`MINDBLOWN_URL=https://mindblown.example.com pnpm sync`).
 */
const url = process.env.MINDBLOWN_URL;

const config: CapacitorConfig = {
  appId: 'com.mindblown.app',
  appName: 'MindBlown',
  webDir: 'www',
  ...(url ? { server: { url, cleartext: url.startsWith('http://') } } : {}),
};

export default config;
