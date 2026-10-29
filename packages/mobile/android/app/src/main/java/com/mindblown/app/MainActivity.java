package com.mindblown.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;
import com.mindblown.app.widget.KanbanWidgetProvider;
import com.mindblown.app.widget.WidgetPlugin;
import com.mindblown.app.widget.WidgetStore;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(WidgetPlugin.class);
        super.onCreate(savedInstanceState);
        openWidgetLink(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        openWidgetLink(intent);
    }

    @Override
    public void onResume() {
        super.onResume();
        // Foreground = a fresh board on the home screen next time you look.
        KanbanWidgetProvider.refreshAll(this);
    }

    /** A widget tap: open the map's kanban (`?map=&view=kanban`), at the card when a row was tapped. */
    private void openWidgetLink(Intent intent) {
        Uri data = intent != null ? intent.getData() : null;
        if (data == null || !KanbanWidgetProvider.DEEP_LINK_SCHEME.equals(data.getScheme())) return;
        String map = data.getQueryParameter("map");
        String serverUrl = new WidgetStore(this).getServerUrl();
        if (map == null || serverUrl == null || getBridge() == null) return;
        Uri.Builder target = Uri.parse(serverUrl + "/").buildUpon()
            .appendQueryParameter("map", map)
            .appendQueryParameter("view", "kanban");
        String node = data.getQueryParameter("node");
        if (node != null) target.appendQueryParameter("node", node);
        String url = target.build().toString();
        getBridge().getWebView().post(() -> getBridge().getWebView().loadUrl(url));
    }
}
