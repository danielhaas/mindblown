/**
 * A map — or one subtree — as a Markdown timeline for someone who is not on
 * the project (#637): when is each milestone done, and what is it waiting on.
 *
 * Pure: the caller hands in the nodes and the scheduler's projected span per
 * node (dates already resolved on the map's calendar), so the same document
 * comes out of the REST export, the MCP tool and the wiki publish.
 *
 * Sections are the root's children (the milestones), in schedule order.
 * `detail: 'summary'` (the default) shows no node ids, effort numbers or
 * other internal fields; `'full'` adds them.
 */
import type { EffortUnit, Node, NodeId, StatusDef } from './types.js';
import { isForgeLink } from './types.js';
import { computeProgress } from './compute.js';
import { buildIsDonePredicate, resolveStatusDef } from './statusWorkflow.js';
import { proseMirrorToPlainText } from './richtext.js';
import { BLOCKED_TAG } from './dispatch.js';
import { isInParkedBranch } from './parked.js';

export type TimelineDetail = 'summary' | 'full';
export const TIMELINE_DETAILS: readonly TimelineDetail[] = ['summary', 'full'];

/** Leaves tagged this way wait on someone outside the team. */
export const EXTERNAL_TAG = 'external';

/** A node's projected bar: first and last day (both inclusive, YYYY-MM-DD). */
export interface TimelineSpan {
  start: string;
  end: string;
}

export interface TimelineInput {
  mapName: string;
  nodes: Node[];
  statusWorkflow: StatusDef[];
  /** The node whose children become the sections (the map root, or a subtree). */
  rootNodeId: NodeId;
  /** Projected span per node, from the scheduler. */
  spans: Map<NodeId, TimelineSpan>;
  generatedAt: Date;
  /** IANA zone the "generated" stamp is shown in (#595); default UTC. */
  timeZone?: string;
  detail?: TimelineDetail;
  /** How many delivered leaves a done milestone names before "+N more". */
  deliveredCap?: number;
  /** How many open leaves a milestone lists before "+N more". */
  openCap?: number;
  effortUnit?: EffortUnit;
  /** Lines put right under the title (e.g. the wiki's "read-only copy" note). */
  preface?: string[];
}

export type MilestoneStatus = 'done' | 'in_progress' | 'not_started' | 'blocked';

const STATUS_LABEL: Record<MilestoneStatus, string> = {
  done: 'Done',
  in_progress: 'In progress',
  not_started: 'Not started',
  blocked: 'Blocked',
};

export interface TimelineWaiting {
  node: Node;
  /** Why it waits / who owns it: the blocker reason and the description. */
  note: string;
}

export interface TimelineMilestone {
  node: Node;
  status: MilestoneStatus;
  progress: number;
  span: TimelineSpan | null;
  waiting: TimelineWaiting[];
  open: Node[];
  delivered: Node[];
  effort: number;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "2026-11-19" → "Thu 19 Nov 2026" — a calendar date, no zone shift. */
export function formatTimelineDay(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Is this an IANA time zone the runtime knows? */
export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The instant as "YYYY-MM-DD HH:MM" on the given zone's clock. */
function stamp(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

/** Text safe inside a Markdown table cell or a link label. */
function cell(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
}

function inline(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/([[\]])/g, '\\$1').trim();
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function spanText(span: TimelineSpan | null): string {
  if (!span) return 'not scheduled';
  return span.start === span.end
    ? formatTimelineDay(span.start)
    : `${formatTimelineDay(span.start)} → ${formatTimelineDay(span.end)}`;
}

function effortText(effort: number, unit: EffortUnit | undefined): string {
  const n = Math.round(effort * 10) / 10;
  const u = unit === 'hours' ? 'h' : unit === 'points' ? 'pts' : 'd';
  return `${n} ${u}`;
}

/**
 * Leaves under a node in tree order; a childless node is its own leaf.
 * `skipParked`: parked branches below (#655) are left out — they are listed
 * under "Later" instead.
 */
function leavesOf(node: Node, byId: Map<NodeId, Node>, skipParked = false): Node[] {
  if (node.childrenIds.length === 0) return [node];
  const out: Node[] = [];
  for (const id of node.childrenIds) {
    const child = byId.get(id);
    if (child && !(skipParked && child.parked === true)) out.push(...leavesOf(child, byId, skipParked));
  }
  return out;
}

/**
 * The parked branches under the export root (#655), in tree order: the
 * top-most parked node of each, listed under "Later" without dates. Empty
 * when the root itself sits in a parked branch — then the whole export is
 * that branch.
 */
export function timelineLater(input: Pick<TimelineInput, 'nodes' | 'rootNodeId'>): Node[] {
  const byId = new Map(input.nodes.map((n) => [n.id, n]));
  const root = byId.get(input.rootNodeId);
  if (!root || isInParkedBranch(root, byId)) return [];
  const out: Node[] = [];
  const walk = (n: Node) => {
    for (const id of n.childrenIds) {
      const child = byId.get(id);
      if (!child) continue;
      if (child.parked === true) out.push(child);
      else walk(child);
    }
  };
  walk(root);
  return out;
}

/** Is the leaf waiting on someone: blocked by hand, or tagged external. */
export function isWaitingLeaf(node: Node): boolean {
  return (
    node.blockedReason != null ||
    node.tags.includes(BLOCKED_TAG) ||
    node.tags.some((t) => t.toLowerCase() === EXTERNAL_TAG)
  );
}

function waitingNote(node: Node): string {
  const parts: string[] = [];
  if (node.blockedReason) parts.push(node.blockedReason.trim());
  const desc = proseMirrorToPlainText(node.description).trim();
  if (desc) {
    // First paragraph only — the owner and the ask, not the whole brief.
    const first = desc.split(/\n\s*\n/)[0];
    if (!parts.some((p) => p === first.trim())) parts.push(clip(first.replace(/\s+/g, ' '), 280));
  }
  return parts.join(' — ');
}

function issueLink(node: Node): string | null {
  const link = node.externalLinks.find((l) => isForgeLink(l) && l.url) ?? node.externalLinks.find((l) => l.url);
  return link ? link.url : null;
}

/** Build the per-milestone reading, in schedule order. */
export function timelineMilestones(input: TimelineInput): TimelineMilestone[] {
  const byId = new Map(input.nodes.map((n) => [n.id, n]));
  const root = byId.get(input.rootNodeId);
  if (!root) return [];
  // Parked branches (#655) go to "Later", not into the milestones — unless
  // the export is of a parked branch itself.
  const skipParked = !isInParkedBranch(root, byId);
  const isDoneStatus = buildIsDonePredicate(input.statusWorkflow);
  const leafDone = (n: Node) => isDoneStatus(n.status) || (n.percentComplete ?? 0) >= 100;
  const leafStarted = (n: Node) =>
    resolveStatusDef(input.statusWorkflow, n.status)?.category === 'in_progress' || (n.percentComplete ?? 0) > 0;

  const milestones: TimelineMilestone[] = [];
  for (const id of root.childrenIds) {
    const node = byId.get(id);
    if (!node || (skipParked && node.parked === true)) continue;
    const leaves = leavesOf(node, byId, skipParked);
    const done = leaves.filter(leafDone);
    const remaining = leaves.filter((l) => !leafDone(l));
    const waiting = remaining.filter(isWaitingLeaf).map((n) => ({ node: n, note: waitingNote(n) }));
    const waitingIds = new Set(waiting.map((w) => w.node.id));
    const open = remaining.filter((l) => !waitingIds.has(l.id));
    const progress = Math.round(computeProgress(node, byId));
    const started = done.length > 0 || remaining.some(leafStarted);
    const status: MilestoneStatus =
      remaining.length === 0
        ? 'done'
        : waiting.length > 0 && !remaining.some((l) => !waitingIds.has(l.id) && leafStarted(l))
          ? 'blocked'
          : started
            ? 'in_progress'
            : 'not_started';
    milestones.push({
      node,
      status,
      progress: status === 'done' ? 100 : progress,
      span: input.spans.get(node.id) ?? null,
      waiting,
      open,
      delivered: done,
      effort: leaves.reduce((s, l) => s + (l.effortEstimate ?? 0), 0),
    });
  }

  // Schedule order: projected start, then end; unscheduled last, tree order kept.
  const indexed = milestones.map((m, i) => ({ m, i }));
  indexed.sort((a, b) => {
    const sa = a.m.span;
    const sb = b.m.span;
    if (!sa || !sb) return sa ? -1 : sb ? 1 : a.i - b.i;
    return sa.start.localeCompare(sb.start) || sa.end.localeCompare(sb.end) || a.i - b.i;
  });
  return indexed.map((x) => x.m);
}

/** Render the timeline document. */
export function renderTimelineMarkdown(input: TimelineInput): string {
  const detail = input.detail ?? 'summary';
  const full = detail === 'full';
  const deliveredCap = input.deliveredCap ?? 10;
  const openCap = input.openCap ?? 10;
  const tz = input.timeZone ?? 'UTC';
  const byId = new Map(input.nodes.map((n) => [n.id, n]));
  const root = byId.get(input.rootNodeId);
  const milestones = timelineMilestones(input);
  const later = timelineLater(input);

  const title = root && root.parentId !== null ? `${input.mapName} — ${root.text}` : input.mapName;
  const out: string[] = [`# ${inline(title)} — timeline`, ''];
  if (input.preface && input.preface.length > 0) out.push(...input.preface, '');

  const overall = root ? Math.round(computeProgress(root, byId)) : 0;
  const rootSpan = root ? input.spans.get(root.id) : undefined;
  const ends = milestones.map((m) => m.span?.end).filter((d): d is string => !!d).sort();
  const projectedEnd = rootSpan?.end ?? ends[ends.length - 1];
  const head = [
    `Generated ${stamp(input.generatedAt, tz)} (${tz})`,
    `${overall}% complete`,
    milestones.length > 0 && milestones.every((m) => m.status === 'done')
      ? 'all milestones done'
      : projectedEnd
        ? `projected end ${formatTimelineDay(projectedEnd)}`
        : 'no projected end yet',
  ];
  if (full && root) head.push(`root \`${root.id}\``);
  out.push(head.join(' · '), '');

  if (milestones.length === 0) {
    out.push('_Nothing planned under this node yet._', '');
    pushLater(out, later, byId, full, input.effortUnit);
    return out.join('\n').replace(/\n+$/, '\n');
  }

  // ── Summary table ──
  out.push('| Milestone | Status | Projected | Waiting on |', '|---|---|---|---|');
  for (const m of milestones) {
    const status = m.status === 'done' || m.status === 'not_started' ? STATUS_LABEL[m.status] : `${STATUS_LABEL[m.status]} (${m.progress}%)`;
    const when = m.status === 'done' ? (m.span ? `done ${formatTimelineDay(m.span.end)}` : 'done') : spanText(m.span);
    const names = m.waiting.map((w) => cell(w.node.text));
    const waiting = names.length === 0 ? '—' : names.length > 3 ? `${names.slice(0, 3).join('; ')}; +${names.length - 3} more` : names.join('; ');
    out.push(`| ${cell(m.node.text)} | ${status} | ${when} | ${waiting} |`);
  }
  out.push('');

  // ── One section per milestone ──
  for (const m of milestones) {
    const idSuffix = full ? ` \`${m.node.id}\`` : '';
    if (m.status === 'done') {
      out.push(`## ${inline(m.node.text)} — done${idSuffix}`, '');
      const when = m.span ? `Done ${formatTimelineDay(m.span.end)}.` : 'Done.';
      const names = m.delivered.map((l) => inline(l.text));
      const shown = names.slice(0, deliveredCap);
      const more = names.length > shown.length ? `, +${names.length - shown.length} more` : '';
      out.push(`${when} Delivered: ${shown.join(', ')}${more}.`, '');
      continue;
    }

    out.push(`## ${inline(m.node.text)}${idSuffix}`, '');
    const facts = [`**${STATUS_LABEL[m.status]}**`, `${m.progress}% complete`, `projected ${spanText(m.span)}`];
    if (full) facts.push(`effort ${effortText(m.effort, input.effortUnit)}`);
    out.push(facts.join(' · '), '');

    if (m.waiting.length > 0) {
      out.push('**Waiting on**', '');
      for (const w of m.waiting) {
        const link = issueLink(w.node);
        const label = link ? `[${inline(w.node.text)}](${link})` : `**${inline(w.node.text)}**`;
        const extra = full ? ` \`${w.node.id}\`` : '';
        out.push(`- ${label}${w.note ? ` — ${w.note.replace(/\s+/g, ' ')}` : ''}${extra}`);
      }
      out.push('');
    }

    if (m.open.length > 0) {
      out.push('**Still to do**', '');
      for (const l of m.open.slice(0, openCap)) {
        const link = issueLink(l);
        const label = link ? `[${inline(l.text)}](${link})` : inline(l.text);
        const extras: string[] = [];
        if (full) {
          if (l.effortEstimate != null) extras.push(effortText(l.effortEstimate, input.effortUnit));
          if (l.percentComplete) extras.push(`${l.percentComplete}%`);
          extras.push(`\`${l.id}\``);
        }
        out.push(`- ${label}${extras.length > 0 ? ` (${extras.join(', ')})` : ''}`);
      }
      if (m.open.length > openCap) out.push(`- …and ${m.open.length - openCap} more`);
      out.push('');
    }

    if (m.delivered.length > 0) {
      const names = m.delivered.map((l) => inline(l.text));
      const shown = names.slice(0, deliveredCap);
      const more = names.length > shown.length ? `, +${names.length - shown.length} more` : '';
      out.push(`Already delivered: ${shown.join(', ')}${more}.`, '');
    }
  }

  pushLater(out, later, byId, full, input.effortUnit);
  return out.join('\n').replace(/\n+$/, '\n');
}

/** The "Later" section (#655): parked branches, no dates — they are not planned. */
function pushLater(out: string[], later: Node[], byId: Map<NodeId, Node>, full: boolean, unit: EffortUnit | undefined): void {
  if (later.length === 0) return;
  out.push('## Later', '', '_Parked — kept for context, not planned and not scheduled._', '');
  for (const n of later) {
    const link = issueLink(n);
    const label = link ? `[${inline(n.text)}](${link})` : inline(n.text);
    const extras: string[] = [];
    if (full) {
      const effort = leavesOf(n, byId).reduce((s, l) => s + (l.effortEstimate ?? 0), 0);
      if (effort > 0) extras.push(effortText(effort, unit));
      extras.push(`\`${n.id}\``);
    }
    out.push(`- ${label}${extras.length > 0 ? ` (${extras.join(', ')})` : ''}`);
  }
  out.push('');
}
