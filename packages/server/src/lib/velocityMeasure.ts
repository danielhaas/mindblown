import { analyzeRepoThroughput, netDeliveryRate, type RepoThroughput } from '@mindblown/core';
import { computeVelocity, MIN_SAMPLE_EVENTS, type VelocityResult } from './velocity.js';
import { getGitHubContextForMap } from './githubContext.js';
import { fetchMergedPrsSince } from './repoThroughput.js';
import * as events from '../db/events.js';
import type { MeasuredRates } from './releaseForecast.js';
import type { MindMap, Node as CoreNode } from '@mindblown/core';

/**
 * One measurement, three consumers.
 *
 * Gathers the map's organic completion velocity (change_events, bulk writes
 * excluded) plus the connected repo's rework share, and distils them into
 * the two NET rates the forecasts run on:
 *
 *   netEffortPerDay  — estimate-units/day × (1 − rework). The day model.
 *   netTicketsPerDay — completion events/day × (1 − rework). The ticket
 *                      model: counts open leaves instead of summing
 *                      estimates, so unestimated work still weighs in.
 *
 * Used by GET /velocity, GET /completion-forecast, the release-forecast
 * routes and the hourly snapshot job — one implementation so the models
 * can never quietly diverge between surfaces.
 *
 * Rates are null when the evidence is too thin (< MIN_SAMPLE_EVENTS
 * organic completions) — callers fall back to knob-based projections.
 * A missing repo context degrades rework to 0 (net == gross) rather than
 * failing: gross is optimistic but still a measurement.
 */
export interface MapVelocityMeasurement {
  velocity: VelocityResult;
  /** True when the change_events query hit its 10k limit (window undercounted). */
  eventsTruncated: boolean;
  repoThroughput:
    | (RepoThroughput & {
        repo: string;
        grossRatePerDay: number;
        netRatePerDay: number;
        truncated: boolean;
      })
    | null;
  rates: MeasuredRates;
}

export async function measureMapVelocity(
  mapId: string,
  data: { map: MindMap; nodes: CoreNode[] },
  windowDays = 56,
  log?: { warn: (obj: unknown, msg: string) => void },
  opts?: {
    /** Re-crawl the repo even if a fresh cached throughput result exists.
     *  Passed by the hourly snapshot cron (keeps the cache warm) and by
     *  the explicit ?refresh=1 flow. */
    freshThroughput?: boolean;
  },
): Promise<MapVelocityMeasurement> {
  const since = new Date(Date.now() - windowDays * 86_400_000);

  // Current estimate per leaf — the weight for progress deltas (same proxy
  // burnup uses; cross-time estimate drift is rare enough to ignore).
  const estimateByNodeId = new Map<string, number>();
  for (const n of data.nodes) {
    if ((n.childrenIds?.length ?? 0) === 0 && n.effortEstimate != null) {
      estimateByNodeId.set(n.id, n.effortEstimate);
    }
  }

  const progressEvents = await events.listEvents({
    mapId,
    fieldName: 'percentComplete',
    since,
    limit: 10_000,
  });

  const unitsPerDay = data.map.effortUnit === 'hours' ? (data.map.hoursPerDay ?? 8) : 1;
  const workerCount = Math.max(1, Math.min(100, Math.floor(data.map.workerCount ?? 1)));

  const velocity = computeVelocity({
    windowDays,
    unitsPerDay,
    workerCount,
    currentFocusFactor: data.map.focusFactor ?? 1,
    estimateByNodeId,
    progressEvents: progressEvents.map((e) => ({
      nodeId: e.nodeId,
      oldValue: e.oldValue,
      newValue: e.newValue,
      createdAt: e.createdAt,
    })),
  });

  let repoThroughput: MapVelocityMeasurement['repoThroughput'] = null;
  try {
    const ctx = await getGitHubContextForMap(mapId);
    if (ctx) {
      const { prs, truncated } = await fetchMergedPrsSince(ctx, since.getTime(), undefined, {
        bypassCache: opts?.freshThroughput,
      });
      const rt = analyzeRepoThroughput(prs);
      repoThroughput = {
        ...rt,
        repo: `${ctx.owner}/${ctx.repo}`,
        grossRatePerDay: velocity.deliveryRate,
        netRatePerDay: netDeliveryRate(velocity.deliveryRate, rt.reworkFraction),
        truncated,
      };
    }
  } catch (err) {
    log?.warn({ err }, 'repo throughput fetch failed — rates degrade to gross');
  }

  const rework = repoThroughput?.reworkFraction ?? 0;
  const sufficient = velocity.completionEvents >= MIN_SAMPLE_EVENTS;
  const rates: MeasuredRates = {
    netEffortPerDay:
      sufficient && velocity.deliveryRate > 0
        ? netDeliveryRate(velocity.deliveryRate, rework)
        : null,
    netTicketsPerDay: sufficient
      ? (velocity.completionEvents / windowDays) * (1 - rework)
      : null,
    windowDays,
  };

  return { velocity, eventsTruncated: progressEvents.length >= 10_000, repoThroughput, rates };
}
