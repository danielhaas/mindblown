package com.mindblown.app.widget;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.format.DateFormat;
import android.text.style.ForegroundColorSpan;
import android.text.style.StyleSpan;
import android.view.View;
import android.widget.RemoteViews;

import com.mindblown.app.MainActivity;
import com.mindblown.app.R;

import org.json.JSONException;

import java.util.Date;
import java.util.List;

/**
 * The kanban home-screen widget (#589): one map's board at a glance — what
 * is in progress, what is blocked and why, WIP against the limit. Read-only.
 *
 * Refreshes on the OS cadence (updatePeriodMillis, 30 min), when the app
 * comes to the foreground (MainActivity.onResume) and when the web app
 * signs in or out. Each refresh draws the cached board first, then fetches;
 * a failed fetch keeps the cached board, marked stale once it is older than
 * the refresh window. Tapping the widget opens the map's kanban, tapping a
 * row opens the kanban at that card.
 */
public class KanbanWidgetProvider extends AppWidgetProvider {
    /** Intent data scheme MainActivity turns into a web-app URL. */
    public static final String DEEP_LINK_SCHEME = "mindblown-widget";

    private static final int COLOR_MUTED = 0xFF64748B;
    private static final int COLOR_ALERT = 0xFFDC2626;
    private static final int COLOR_TEXT = 0xFF0F172A;
    /** Rough heights for the size budget: header + counts, and one row. */
    private static final int HEADER_DP = 52;
    private static final int ROW_DP = 22;

    /** Ask every placed widget to refresh — app foreground, sign-in, sign-out. */
    public static void refreshAll(Context context) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(context);
        int[] ids = mgr.getAppWidgetIds(new ComponentName(context, KanbanWidgetProvider.class));
        if (ids.length == 0) return;
        Intent intent = new Intent(context, KanbanWidgetProvider.class);
        intent.setAction(AppWidgetManager.ACTION_APPWIDGET_UPDATE);
        intent.putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids);
        context.sendBroadcast(intent);
    }

    @Override
    public void onUpdate(Context context, AppWidgetManager mgr, int[] widgetIds) {
        WidgetStore store = new WidgetStore(context);
        for (int id : widgetIds) render(context, mgr, store, id, false);
        if (!store.isSignedIn()) return;

        final PendingResult pending = goAsync();
        final Context app = context.getApplicationContext();
        new Thread(() -> {
            try {
                fetchAll(app, mgr, store, widgetIds);
            } finally {
                pending.finish();
            }
        }).start();
    }

    @Override
    public void onAppWidgetOptionsChanged(Context context, AppWidgetManager mgr, int widgetId, Bundle newOptions) {
        render(context, mgr, new WidgetStore(context), widgetId, false);
    }

    @Override
    public void onDeleted(Context context, int[] widgetIds) {
        WidgetStore store = new WidgetStore(context);
        for (int id : widgetIds) store.forget(id);
    }

    private static void fetchAll(Context context, AppWidgetManager mgr, WidgetStore store, int[] widgetIds) {
        WidgetApi api = new WidgetApi(store.getServerUrl(), store.getToken());
        for (int id : widgetIds) {
            String mapId = store.getMapId(id);
            if (mapId == null) continue;
            WidgetApi.Result res = api.boardSummary(mapId);
            if (res.status == WidgetApi.Status.UNAUTHORIZED) {
                // The token is gone or revoked: every widget goes to "sign in".
                store.signOut();
                for (int other : widgetIds) render(context, mgr, store, other, false);
                return;
            }
            if (res.status == WidgetApi.Status.OK) store.saveSummary(id, res.body, System.currentTimeMillis());
            render(context, mgr, store, id, res.status == WidgetApi.Status.ERROR);
        }
    }

    static void render(Context context, AppWidgetManager mgr, WidgetStore store, int widgetId, boolean fetchFailed) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_board);
        views.removeAllViews(R.id.widget_rows);

        if (!store.isSignedIn()) {
            showMessage(views, context.getString(R.string.app_name), context.getString(R.string.widget_sign_in));
            views.setOnClickPendingIntent(R.id.widget_root, openApp(context, widgetId, null, null));
            mgr.updateAppWidget(widgetId, views);
            return;
        }

        String mapId = store.getMapId(widgetId);
        if (mapId == null) {
            showMessage(views, context.getString(R.string.app_name), context.getString(R.string.widget_pick_map));
            views.setOnClickPendingIntent(R.id.widget_root, configure(context, widgetId));
            mgr.updateAppWidget(widgetId, views);
            return;
        }

        views.setOnClickPendingIntent(R.id.widget_root, openApp(context, widgetId, mapId, null));
        String mapName = store.getMapName(widgetId);
        BoardSnapshot board = null;
        String cached = store.getSummary(widgetId);
        if (cached != null) {
            try {
                board = BoardSnapshot.parse(cached);
            } catch (JSONException ignored) {
                // A cache from an older server shape — draw as if empty, the next fetch replaces it.
            }
        }

        if (board == null) {
            showMessage(views, mapName != null ? mapName : context.getString(R.string.app_name),
                context.getString(fetchFailed ? R.string.widget_unreachable : R.string.widget_loading));
            mgr.updateAppWidget(widgetId, views);
            return;
        }

        views.setTextViewText(R.id.widget_title, board.mapName.isEmpty() ? mapName : board.mapName);
        long fetchedAt = store.getFetchedAt(widgetId);
        boolean stale = BoardSnapshot.isStale(fetchedAt, System.currentTimeMillis());
        String time = DateFormat.getTimeFormat(context).format(new Date(fetchedAt));
        views.setTextViewText(R.id.widget_updated, stale
            ? context.getString(R.string.widget_stale, time)
            : context.getString(R.string.widget_updated, time));
        views.setTextColor(R.id.widget_updated, stale ? COLOR_ALERT : COLOR_MUTED);
        views.setTextViewText(R.id.widget_counts, board.countsLine());
        views.setTextColor(R.id.widget_counts, board.overWipLimit() ? COLOR_ALERT : COLOR_MUTED);
        views.setViewVisibility(R.id.widget_counts, View.VISIBLE);
        views.setViewVisibility(R.id.widget_message, View.GONE);

        int[] fit = board.fit(rowBudget(mgr, widgetId));
        addSection(context, views, widgetId, mapId, R.string.widget_in_progress, board.inProgress, fit[0], COLOR_MUTED);
        addSection(context, views, widgetId, mapId, R.string.widget_blocked, board.blocked, fit[1], COLOR_ALERT);
        if (board.inProgressCount == 0 && board.blockedCount == 0) {
            views.setTextViewText(R.id.widget_message, context.getString(R.string.widget_quiet));
            views.setViewVisibility(R.id.widget_message, View.VISIBLE);
        }
        mgr.updateAppWidget(widgetId, views);
    }

    private static void addSection(Context context, RemoteViews views, int widgetId, String mapId,
                                   int labelRes, List<BoardSnapshot.Item> items, int count, int detailColor) {
        if (count <= 0) return;
        RemoteViews header = new RemoteViews(context.getPackageName(), R.layout.widget_section);
        header.setTextViewText(R.id.section_text, context.getString(labelRes));
        views.addView(R.id.widget_rows, header);
        for (int i = 0; i < count; i++) {
            BoardSnapshot.Item item = items.get(i);
            RemoteViews row = new RemoteViews(context.getPackageName(), R.layout.widget_row);
            row.setTextViewText(R.id.row_text, rowText(item, detailColor));
            row.setOnClickPendingIntent(R.id.row_text, openApp(context, widgetId, mapId, item.id));
            views.addView(R.id.widget_rows, row);
        }
    }

    private static CharSequence rowText(BoardSnapshot.Item item, int detailColor) {
        SpannableStringBuilder sb = new SpannableStringBuilder(item.title);
        sb.setSpan(new ForegroundColorSpan(COLOR_TEXT), 0, sb.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        sb.setSpan(new StyleSpan(Typeface.BOLD), 0, sb.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        if (item.detail != null && !item.detail.isEmpty()) {
            int start = sb.length();
            sb.append(" · ").append(item.detail);
            sb.setSpan(new ForegroundColorSpan(detailColor), start, sb.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        }
        return sb;
    }

    private static void showMessage(RemoteViews views, String title, String message) {
        views.setTextViewText(R.id.widget_title, title);
        views.setTextViewText(R.id.widget_updated, "");
        views.setViewVisibility(R.id.widget_counts, View.GONE);
        views.setTextViewText(R.id.widget_message, message);
        views.setViewVisibility(R.id.widget_message, View.VISIBLE);
    }

    /** Lines that fit: the widget's current height (portrait = max height) less the header. */
    private static int rowBudget(AppWidgetManager mgr, int widgetId) {
        Bundle opts = mgr.getAppWidgetOptions(widgetId);
        int height = opts.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 0);
        if (height <= 0) height = opts.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 0);
        if (height <= 0) height = 180;
        return Math.max(1, (height - HEADER_DP) / ROW_DP);
    }

    /** Opens the app — at the map's kanban, at a card on it, or (no map) wherever it was. */
    private static PendingIntent openApp(Context context, int widgetId, String mapId, String nodeId) {
        Intent intent = new Intent(context, MainActivity.class);
        intent.setAction(Intent.ACTION_VIEW);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        Uri.Builder uri = new Uri.Builder().scheme(DEEP_LINK_SCHEME).authority("open")
            .appendQueryParameter("widget", String.valueOf(widgetId));
        if (mapId != null) uri.appendQueryParameter("map", mapId);
        if (nodeId != null) uri.appendQueryParameter("node", nodeId);
        // A distinct data URI per target keeps the PendingIntents apart.
        intent.setData(uri.build());
        return PendingIntent.getActivity(context, 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static PendingIntent configure(Context context, int widgetId) {
        Intent intent = new Intent(context, WidgetConfigActivity.class);
        intent.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId);
        intent.setData(Uri.parse(DEEP_LINK_SCHEME + "://configure/" + widgetId));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return PendingIntent.getActivity(context, 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
