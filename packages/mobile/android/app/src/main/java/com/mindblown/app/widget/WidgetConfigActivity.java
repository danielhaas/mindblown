package com.mindblown.app.widget;

import android.app.Activity;
import android.appwidget.AppWidgetManager;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.ListView;
import android.widget.TextView;

import com.mindblown.app.MainActivity;
import com.mindblown.app.R;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * Picks the map a widget shows — when the widget is placed, and again from
 * the launcher's "reconfigure" (widgetFeatures). Signed out, it says so and
 * offers to open the app, where signing in hands the token over.
 */
public class WidgetConfigActivity extends Activity {
    private int widgetId = AppWidgetManager.INVALID_APPWIDGET_ID;
    private final List<String> mapIds = new ArrayList<>();
    private final List<String> mapNames = new ArrayList<>();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Backing out leaves no half-placed widget.
        setResult(RESULT_CANCELED);
        setContentView(R.layout.widget_config);

        Bundle extras = getIntent().getExtras();
        if (extras != null) widgetId = extras.getInt(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId);
        if (widgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
            finish();
            return;
        }

        WidgetStore store = new WidgetStore(this);
        TextView status = findViewById(R.id.config_status);
        Button openApp = findViewById(R.id.config_open_app);
        openApp.setOnClickListener(v -> {
            startActivity(new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            finish();
        });

        if (!store.isSignedIn()) {
            status.setText(R.string.widget_config_sign_in);
            openApp.setVisibility(View.VISIBLE);
            return;
        }

        status.setText(R.string.widget_config_loading);
        Handler main = new Handler(Looper.getMainLooper());
        new Thread(() -> {
            WidgetApi.Result res = new WidgetApi(store.getServerUrl(), store.getToken()).maps();
            main.post(() -> showMaps(store, res, status, openApp));
        }).start();
    }

    private void showMaps(WidgetStore store, WidgetApi.Result res, TextView status, Button openApp) {
        if (isFinishing()) return;
        if (res.status == WidgetApi.Status.UNAUTHORIZED) {
            store.signOut();
            status.setText(R.string.widget_config_sign_in);
            openApp.setVisibility(View.VISIBLE);
            return;
        }
        if (res.status != WidgetApi.Status.OK) {
            status.setText(R.string.widget_unreachable);
            return;
        }
        try {
            JSONArray arr = new JSONArray(res.body);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject m = arr.getJSONObject(i);
                mapIds.add(m.getString("id"));
                mapNames.add(m.optString("name", m.getString("id")));
            }
        } catch (JSONException e) {
            status.setText(R.string.widget_unreachable);
            return;
        }
        if (mapIds.isEmpty()) {
            status.setText(R.string.widget_config_no_maps);
            return;
        }
        status.setText(R.string.widget_config_pick);
        ListView list = findViewById(R.id.config_maps);
        list.setAdapter(new ArrayAdapter<>(this, android.R.layout.simple_list_item_1, mapNames));
        list.setOnItemClickListener((parent, view, position, id) -> pick(store, position));
    }

    private void pick(WidgetStore store, int position) {
        store.setMap(widgetId, mapIds.get(position), mapNames.get(position));
        KanbanWidgetProvider.render(this, AppWidgetManager.getInstance(this), store, widgetId, false);
        KanbanWidgetProvider.refreshAll(this);
        setResult(RESULT_OK, new Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId));
        finish();
    }
}
