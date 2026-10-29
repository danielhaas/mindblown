package com.mindblown.app.widget;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The web app's handle on the widget (mindmap/src/homeWidget.ts): it hands
 * over a long-lived token on sign-in, takes it back on sign-out, and asks
 * which user the widget is signed in as so it mints a token only once.
 */
@CapacitorPlugin(name = "MindBlownWidget")
public class WidgetPlugin extends Plugin {

    @PluginMethod
    public void status(PluginCall call) {
        WidgetStore store = new WidgetStore(getContext());
        JSObject ret = new JSObject();
        ret.put("userId", store.isSignedIn() ? store.getUserId() : null);
        ret.put("serverUrl", store.getServerUrl());
        call.resolve(ret);
    }

    @PluginMethod
    public void signIn(PluginCall call) {
        String serverUrl = call.getString("serverUrl");
        String token = call.getString("token");
        String userId = call.getString("userId");
        if (serverUrl == null || token == null || userId == null) {
            call.reject("serverUrl, token and userId are required");
            return;
        }
        new WidgetStore(getContext()).signIn(serverUrl, token, userId);
        KanbanWidgetProvider.refreshAll(getContext());
        call.resolve();
    }

    @PluginMethod
    public void signOut(PluginCall call) {
        new WidgetStore(getContext()).signOut();
        KanbanWidgetProvider.refreshAll(getContext());
        call.resolve();
    }
}
