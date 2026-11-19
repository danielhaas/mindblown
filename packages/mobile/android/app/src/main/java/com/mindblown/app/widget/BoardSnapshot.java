package com.mindblown.app.widget;

import java.util.ArrayList;
import java.util.List;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The server's board summary (GET /api/maps/:id/board-summary, core
 * `summarizeBoard`), parsed — plus the widget's rules for what fits and
 * when it is stale. No Android types, so it is unit-tested on the JVM.
 */
public final class BoardSnapshot {
    /** Android's shortest allowed updatePeriodMillis — the widget's refresh window. */
    public static final long REFRESH_WINDOW_MS = 30 * 60_000L;
    /** A missed refresh shows once the data is older than the window plus this slack. */
    static final long STALE_GRACE_MS = 5 * 60_000L;

    public static final class Item {
        public final String id;
        public final String title;
        /** Parent title for an in-progress card, the blocker reason for a blocked one. */
        public final String detail;

        Item(String id, String title, String detail) {
            this.id = id;
            this.title = title;
            this.detail = detail;
        }
    }

    public final String mapId;
    public final String mapName;
    public final int inProgressCount;
    public final List<Item> inProgress;
    public final int blockedCount;
    public final List<Item> blocked;
    public final int inReview;
    public final int wipCount;
    /** null = the map has no WIP limit. */
    public final Integer wipLimit;

    private BoardSnapshot(JSONObject o) throws JSONException {
        mapId = o.getString("mapId");
        mapName = o.optString("mapName", "");
        JSONObject ip = o.getJSONObject("inProgress");
        inProgressCount = ip.getInt("count");
        inProgress = items(ip.getJSONArray("items"), "context");
        JSONObject bl = o.getJSONObject("blocked");
        blockedCount = bl.getInt("count");
        blocked = items(bl.getJSONArray("items"), "reason");
        inReview = o.optInt("inReview", 0);
        JSONObject wip = o.getJSONObject("wip");
        wipCount = wip.getInt("count");
        wipLimit = wip.isNull("limit") ? null : (int) Math.round(wip.getDouble("limit"));
    }

    public static BoardSnapshot parse(String json) throws JSONException {
        return new BoardSnapshot(new JSONObject(json));
    }

    private static List<Item> items(JSONArray arr, String detailKey) throws JSONException {
        List<Item> out = new ArrayList<>();
        for (int i = 0; i < arr.length(); i++) {
            JSONObject it = arr.getJSONObject(i);
            String detail = it.isNull(detailKey) ? null : it.optString(detailKey, null);
            out.add(new Item(it.getString("id"), it.getString("title"), detail));
        }
        return out;
    }

    public boolean overWipLimit() {
        return wipLimit != null && wipCount > wipLimit;
    }

    /** "3 in progress · 2 blocked · 1 in review · WIP 4/3" — review and WIP only when they say something. */
    public String countsLine() {
        StringBuilder sb = new StringBuilder();
        sb.append(inProgressCount).append(" in progress · ").append(blockedCount).append(" blocked");
        if (inReview > 0) sb.append(" · ").append(inReview).append(" in review");
        if (wipLimit != null) sb.append(" · WIP ").append(wipCount).append('/').append(wipLimit);
        return sb.toString();
    }

    /**
     * How many in-progress and blocked rows to show in `rows` lines (the
     * widget's size budget; each section's header takes one). Blocked gets
     * about a third, at least one row when anything is blocked; what a
     * section leaves unused goes to the other. Returns {inProgress, blocked}.
     */
    public int[] fit(int rows) {
        int ipAvail = inProgress.size();
        int blAvail = blocked.size();
        int budget = rows - (ipAvail > 0 ? 1 : 0) - (blAvail > 0 ? 1 : 0);
        if (budget <= 0) return new int[] {0, 0};
        int bl = Math.min(blAvail, Math.max(blAvail > 0 ? 1 : 0, budget / 3));
        int ip = Math.min(ipAvail, budget - bl);
        bl = Math.min(blAvail, budget - ip);
        return new int[] {ip, bl};
    }

    /** True when the data is older than the last refresh window (a refresh was missed or failed). */
    public static boolean isStale(long fetchedAt, long now) {
        return fetchedAt <= 0 || now - fetchedAt > REFRESH_WINDOW_MS + STALE_GRACE_MS;
    }
}
