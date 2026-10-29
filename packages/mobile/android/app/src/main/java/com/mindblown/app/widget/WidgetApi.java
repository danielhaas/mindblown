package com.mindblown.app.widget;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

/**
 * The two reads the widget makes, with the token the web app handed over:
 * the board summary of one map, and the map list for the picker. Blocking —
 * call off the main thread.
 */
public final class WidgetApi {
    /** Items per list the server returns; the renderer shows what fits. */
    static final int SUMMARY_LIMIT = 10;
    private static final int TIMEOUT_MS = 8_000;

    public enum Status { OK, UNAUTHORIZED, ERROR }

    public static final class Result {
        public final Status status;
        public final String body;

        Result(Status status, String body) {
            this.status = status;
            this.body = body;
        }
    }

    private final String serverUrl;
    private final String token;

    public WidgetApi(String serverUrl, String token) {
        this.serverUrl = serverUrl;
        this.token = token;
    }

    public Result boardSummary(String mapId) {
        return get("/api/maps/" + encode(mapId) + "/board-summary?limit=" + SUMMARY_LIMIT);
    }

    public Result maps() {
        return get("/api/maps");
    }

    private Result get(String path) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(serverUrl + path).openConnection();
            conn.setConnectTimeout(TIMEOUT_MS);
            conn.setReadTimeout(TIMEOUT_MS);
            conn.setRequestProperty("Authorization", "Bearer " + token);
            conn.setRequestProperty("Accept", "application/json");
            int code = conn.getResponseCode();
            if (code == 401 || code == 403) return new Result(Status.UNAUTHORIZED, null);
            if (code != 200) return new Result(Status.ERROR, null);
            return new Result(Status.OK, read(conn.getInputStream()));
        } catch (IOException e) {
            return new Result(Status.ERROR, null);
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static String read(InputStream in) throws IOException {
        try (InputStream is = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = is.read(buf)) != -1) out.write(buf, 0, n);
            return out.toString(StandardCharsets.UTF_8.name());
        }
    }

    private static String encode(String s) {
        try {
            return URLEncoder.encode(s, StandardCharsets.UTF_8.name());
        } catch (IOException e) {
            return s;
        }
    }
}
