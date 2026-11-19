package com.mindblown.app.widget;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * What the widget remembers between refreshes: the sign-in the web app
 * handed over (server origin, a long-lived token, whose it is), and per
 * widget the chosen map and the last summary it fetched.
 */
public final class WidgetStore {
    private static final String PREFS = "mindblown_widget";
    private static final String SERVER_URL = "serverUrl";
    private static final String TOKEN = "token";
    private static final String USER_ID = "userId";

    private final SharedPreferences prefs;

    public WidgetStore(Context context) {
        prefs = context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    // ── Sign-in ──

    public void signIn(String serverUrl, String token, String userId) {
        prefs.edit()
            .putString(SERVER_URL, stripTrailingSlash(serverUrl))
            .putString(TOKEN, token)
            .putString(USER_ID, userId)
            .apply();
    }

    /** Forget the sign-in and every widget's cached board — a signed-out phone shows nothing of the board. */
    public void signOut() {
        SharedPreferences.Editor edit = prefs.edit().remove(TOKEN).remove(USER_ID);
        for (String key : prefs.getAll().keySet()) {
            if (key.startsWith("summary_") || key.startsWith("fetchedAt_")) edit.remove(key);
        }
        edit.apply();
    }

    public boolean isSignedIn() {
        return getToken() != null && getServerUrl() != null;
    }

    public String getServerUrl() {
        return prefs.getString(SERVER_URL, null);
    }

    public String getToken() {
        return prefs.getString(TOKEN, null);
    }

    public String getUserId() {
        return prefs.getString(USER_ID, null);
    }

    // ── Per widget ──

    public void setMap(int widgetId, String mapId, String mapName) {
        prefs.edit()
            .putString("map_" + widgetId, mapId)
            .putString("mapName_" + widgetId, mapName)
            .remove("summary_" + widgetId)
            .remove("fetchedAt_" + widgetId)
            .apply();
    }

    public String getMapId(int widgetId) {
        return prefs.getString("map_" + widgetId, null);
    }

    public String getMapName(int widgetId) {
        return prefs.getString("mapName_" + widgetId, null);
    }

    public void saveSummary(int widgetId, String json, long fetchedAt) {
        prefs.edit().putString("summary_" + widgetId, json).putLong("fetchedAt_" + widgetId, fetchedAt).apply();
    }

    public String getSummary(int widgetId) {
        return prefs.getString("summary_" + widgetId, null);
    }

    public long getFetchedAt(int widgetId) {
        return prefs.getLong("fetchedAt_" + widgetId, 0L);
    }

    public void forget(int widgetId) {
        prefs.edit()
            .remove("map_" + widgetId)
            .remove("mapName_" + widgetId)
            .remove("summary_" + widgetId)
            .remove("fetchedAt_" + widgetId)
            .apply();
    }

    static String stripTrailingSlash(String url) {
        if (url == null) return null;
        return url.endsWith("/") ? url.substring(0, url.length() - 1) : url;
    }
}
