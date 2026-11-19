package com.mindblown.app.widget;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** The widget's reading of GET /api/maps/:id/board-summary and its fit / staleness rules (#589). */
public class BoardSnapshotTest {
    private static final String JSON = "{"
        + "\"mapId\":\"m1\",\"mapName\":\"Launch\",\"generatedAt\":\"2026-10-29T10:00:00.000Z\","
        + "\"inProgress\":{\"count\":3,\"items\":["
        + "{\"id\":\"a\",\"title\":\"Auth\",\"context\":\"API\"},"
        + "{\"id\":\"b\",\"title\":\"Billing\",\"context\":null},"
        + "{\"id\":\"c\",\"title\":\"Cache\",\"context\":\"API\"}]},"
        + "\"blocked\":{\"count\":2,\"items\":["
        + "{\"id\":\"e\",\"title\":\"Email\",\"context\":\"API\",\"reason\":\"Needs Dan\"},"
        + "{\"id\":\"d\",\"title\":\"Docs\",\"context\":null,\"reason\":\"Waiting on Auth\"}]},"
        + "\"inReview\":1,\"wip\":{\"count\":4,\"limit\":3}}";

    @Test
    public void parsesTheSummary() throws Exception {
        BoardSnapshot s = BoardSnapshot.parse(JSON);
        assertEquals("Launch", s.mapName);
        assertEquals(3, s.inProgressCount);
        assertEquals("API", s.inProgress.get(0).detail);
        assertNull(s.inProgress.get(1).detail);
        assertEquals("Needs Dan", s.blocked.get(0).detail);
        assertTrue(s.overWipLimit());
        assertEquals("3 in progress · 2 blocked · 1 in review · WIP 4/3", s.countsLine());
    }

    @Test
    public void noWipLimitLeavesItOut() throws Exception {
        BoardSnapshot s = BoardSnapshot.parse(JSON.replace("\"inReview\":1,\"wip\":{\"count\":4,\"limit\":3}", "\"inReview\":0,\"wip\":{\"count\":3,\"limit\":null}"));
        assertNull(s.wipLimit);
        assertFalse(s.overWipLimit());
        assertEquals("3 in progress · 2 blocked", s.countsLine());
    }

    @Test
    public void fitsRowsToTheSizeBudget() throws Exception {
        BoardSnapshot s = BoardSnapshot.parse(JSON);
        // Two section headers take two lines; blocked keeps at least one row.
        assertArrayEquals(new int[] {1, 1}, s.fit(4));
        assertArrayEquals(new int[] {3, 2}, s.fit(10));
        assertArrayEquals(new int[] {3, 1}, s.fit(6));
        assertArrayEquals(new int[] {0, 0}, s.fit(2));
    }

    @Test
    public void unusedRowsGoToTheOtherSection() throws Exception {
        BoardSnapshot s = BoardSnapshot.parse(JSON.replace(
            "\"inProgress\":{\"count\":3,\"items\":[{\"id\":\"a\",\"title\":\"Auth\",\"context\":\"API\"},{\"id\":\"b\",\"title\":\"Billing\",\"context\":null},{\"id\":\"c\",\"title\":\"Cache\",\"context\":\"API\"}]}",
            "\"inProgress\":{\"count\":0,\"items\":[]}"));
        assertArrayEquals(new int[] {0, 2}, s.fit(5));
    }

    @Test
    public void staleOnceOlderThanTheRefreshWindow() {
        long now = 10_000_000_000L;
        assertFalse(BoardSnapshot.isStale(now - 30 * 60_000L, now));
        assertTrue(BoardSnapshot.isStale(now - 36 * 60_000L, now));
        assertTrue(BoardSnapshot.isStale(0, now));
    }
}
