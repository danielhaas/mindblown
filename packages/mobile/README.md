# MindBlown for Android

A [Capacitor](https://capacitorjs.com) shell around the MindBlown web app,
plus a home-screen widget that shows one map's kanban board at a glance
(#589).

The app loads your MindBlown server in a WebView (`server.url`), so the UI
is always the deployed one — no copy of the web app ships in the APK.

## Build

Needs JDK 21 and the Android SDK (`ANDROID_HOME`).

```bash
cd packages/mobile
MINDBLOWN_URL=https://mindblown.example.com pnpm android:build
# → android/app/build/outputs/apk/debug/app-debug.apk
```

`MINDBLOWN_URL` is baked in at `cap sync` time; without it the app opens a
placeholder page. Widget unit tests: `cd android && ./gradlew testDebugUnitTest`.

## The widget

- **Add it**: long-press the home screen → Widgets → MindBlown. Sign in in
  the app first; the widget then asks which map to show (reconfigure it
  later from the launcher's widget settings).
- **Shows**: the map's in-progress cards (title · parent), blocked cards
  (title · reason), and a counts line — in progress, blocked, in review,
  WIP against the map's WIP limit (red when over). As many rows as the
  widget's size allows; the counts are always complete.
- **Tap**: the widget opens the map's kanban, a row opens the kanban with
  that card's detail sheet.
- **Refresh**: every 30 minutes (the shortest Android allows), whenever
  the app comes to the foreground, and on sign-in. The time of the last
  successful fetch sits top right; it turns into "⚠ stale" once the data is
  older than the refresh window (a refresh failed or was skipped).
- **Signed out**: the widget says "Sign in to MindBlown" and opens the app.

## How it signs in

On sign-in the web app (`packages/mindmap/src/homeWidget.ts`) mints a
long-lived token (`POST /api/auth/long-lived-token`) and hands it, with the
server origin, to the native `MindBlownWidget` plugin. The widget reads
`GET /api/maps/:id/board-summary` with it. Signing out in the app clears
it; a 401 from the server does the same.

Native code: `android/app/src/main/java/com/mindblown/app/widget/`.
