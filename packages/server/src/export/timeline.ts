/**
 * The map's Markdown timeline (#637): the scheduler's projected bars fed into
 * core's renderTimelineMarkdown. One builder for GET /maps/:id/export.md, the
 * export_markdown tool and the wiki publish, so they print the same page.
 */
import { isTimeZone, renderTimelineMarkdown, TIMELINE_DETAILS } from '@mindblown/core';
import type { MindMap, Node as CoreNode, TimelineDetail, TimelineSpan } from '@mindblown/core';
import { computeMapSchedule } from '../lib/mapSchedule.js';

export interface TimelineOptions {
  rootNodeId?: string;
  detail?: string;
  timeZone?: string;
  /** Lines under the title (the wiki's read-only note). */
  preface?: string[];
  now?: Date;
}

export class TimelineOptionError extends Error {}

/** Validate the options; throws TimelineOptionError with a message a caller can show. */
export function buildTimelineMarkdown(data: { map: MindMap; nodes: CoreNode[] }, opts: TimelineOptions = {}): string {
  const detail = opts.detail ?? 'summary';
  if (!(TIMELINE_DETAILS as readonly string[]).includes(detail)) {
    throw new TimelineOptionError(`Unknown detail "${detail}" — use ${TIMELINE_DETAILS.join(' or ')}`);
  }
  const timeZone = opts.timeZone || 'UTC';
  if (!isTimeZone(timeZone)) {
    throw new TimelineOptionError(`Unknown time zone "${timeZone}" — use an IANA name like Europe/Zurich`);
  }
  const rootNodeId = opts.rootNodeId || data.map.rootNodeId;
  if (!rootNodeId || !data.nodes.some((n) => n.id === rootNodeId)) {
    throw new TimelineOptionError(
      opts.rootNodeId ? `Node ${opts.rootNodeId} is not on this map` : 'This map has no root node yet',
    );
  }

  const projection = computeMapSchedule(data);
  const spans = new Map<string, TimelineSpan>();
  for (const s of projection.schedule) spans.set(s.nodeId, projection.barSpan(s));

  return renderTimelineMarkdown({
    mapName: data.map.name,
    nodes: data.nodes,
    statusWorkflow: data.map.statusWorkflow,
    rootNodeId,
    spans,
    generatedAt: opts.now ?? new Date(),
    timeZone,
    detail: detail as TimelineDetail,
    effortUnit: data.map.effortUnit,
    preface: opts.preface,
  });
}
