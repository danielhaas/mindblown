/** A map as a Markdown timeline for readers outside the project (#637). */
import { describe, it, expect } from 'vitest';
import { renderTimelineMarkdown, timelineMilestones, formatTimelineDay } from '../timelineExport.js';
import type { TimelineInput, TimelineSpan } from '../timelineExport.js';
import type { Node, StatusDef } from '../types.js';

function makeNode(overrides: Partial<Node> & { id: string }): Node {
  return {
    mapId: 'map-1',
    parentId: null,
    childrenIds: [],
    text: overrides.id,
    description: null,
    x: null,
    y: null,
    collapsed: false,
    effortEstimate: null,
    actualEffort: null,
    percentComplete: null,
    status: null,
    blockedReason: null,
    assigneeIds: [],
    priority: null,
    dueDate: null,
    startDate: null,
    tags: [],
    customFields: {},
    dependencies: [],
    versionId: null,
    cycleId: null,
    externalLinks: [],
    attachments: [],
    autoProgress: 'off',
    priorityRank: null,
    completedAt: null,
    startedAt: null,
    expectedDoneAt: null,
    requirementId: null,
    requirementPriority: null,
    requirementText: null,
    phaseId: null,
    verificationText: null,
    verificationUrl: null,
    verificationVideoUrl: null,
    verificationVideoPosterUrl: null,
    claimedBySession: null,
    claimedAt: null,
    scopes: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    createdBy: 'user-1',
    reportedBy: null,
    approval: null,
    revision: 1,
    deletedAt: null,
    ...overrides,
  };
}

const workflow: StatusDef[] = [
  { id: 'todo', name: 'Todo', category: 'todo', color: '#ccc', position: 0 },
  { id: 'doing', name: 'In Progress', category: 'in_progress', color: '#00f', position: 1 },
  { id: 'done', name: 'Done', category: 'done', color: '#0f0', position: 2 },
];

const gh = (n: number) => ({
  provider: 'github',
  externalId: `loke/support#${n}`,
  url: `https://github.com/loke/support/issues/${n}`,
  syncEnabled: true,
  lastSyncedAt: null,
});

// Tree order deliberately differs from schedule order: M2 is listed before M1.
function nodes(): Node[] {
  return [
    makeNode({ id: 'root', text: 'Loke-Support', childrenIds: ['m0', 'm2', 'm1'] }),
    makeNode({ id: 'm0', text: 'M0 Discovery', parentId: 'root', childrenIds: ['a', 'b', 'c'] }),
    makeNode({ id: 'a', text: 'Interview support team', parentId: 'm0', status: 'done', percentComplete: 100, effortEstimate: 2 }),
    makeNode({ id: 'b', text: 'Map ticket flows', parentId: 'm0', status: 'done', percentComplete: 100, effortEstimate: 3 }),
    makeNode({ id: 'c', text: 'Write findings', parentId: 'm0', status: 'done', percentComplete: 100, effortEstimate: 1 }),
    makeNode({ id: 'm1', text: 'M1 Infrastructure', parentId: 'root', childrenIds: ['vm', 'deploy', 'done1'] }),
    makeNode({
      id: 'vm',
      text: 'AWS VM',
      parentId: 'm1',
      tags: ['external'],
      description: 'Owner: LOKE IT (Peter). Needs a t3.medium in eu-central-1.\n\nMore internal notes.',
      effortEstimate: 1,
      externalLinks: [gh(12)],
    }),
    makeNode({ id: 'deploy', text: 'Deploy pipeline', parentId: 'm1', status: 'doing', percentComplete: 50, effortEstimate: 4, externalLinks: [gh(13)] }),
    makeNode({ id: 'done1', text: 'Repo set up', parentId: 'm1', status: 'done', percentComplete: 100, effortEstimate: 1 }),
    makeNode({ id: 'm2', text: 'M2 Zendesk', parentId: 'root', childrenIds: ['creds', 'sync'] }),
    makeNode({ id: 'creds', text: 'Zendesk credentials', parentId: 'm2', blockedReason: 'Waiting on LOKE support lead for an API token', effortEstimate: 1 }),
    makeNode({ id: 'sync', text: 'Ticket sync', parentId: 'm2', effortEstimate: 5, externalLinks: [gh(20)] }),
  ];
}

const spans = new Map<string, TimelineSpan>([
  ['root', { start: '2026-10-01', end: '2026-12-18' }],
  ['m0', { start: '2026-10-01', end: '2026-10-09' }],
  ['m1', { start: '2026-11-16', end: '2026-11-27' }],
  ['m2', { start: '2026-11-30', end: '2026-12-18' }],
]);

function input(over: Partial<TimelineInput> = {}): TimelineInput {
  return {
    mapName: 'Loke-Support',
    nodes: nodes(),
    statusWorkflow: workflow,
    rootNodeId: 'root',
    spans,
    generatedAt: new Date('2026-11-19T07:30:00Z'),
    timeZone: 'Europe/Zurich',
    ...over,
  };
}

describe('timeline milestones', () => {
  it('orders sections by the schedule, not the tree', () => {
    expect(timelineMilestones(input()).map((m) => m.node.id)).toEqual(['m0', 'm1', 'm2']);
    const md = renderTimelineMarkdown(input());
    expect(md.indexOf('## M0')).toBeLessThan(md.indexOf('## M1'));
    expect(md.indexOf('## M1')).toBeLessThan(md.indexOf('## M2'));
  });

  it('puts unscheduled milestones last, in tree order', () => {
    const partial = new Map(spans);
    partial.delete('m0');
    expect(timelineMilestones(input({ spans: partial })).map((m) => m.node.id)).toEqual(['m1', 'm2', 'm0']);
  });

  it('reads each milestone status', () => {
    const byId = Object.fromEntries(timelineMilestones(input()).map((m) => [m.node.id, m.status]));
    expect(byId).toEqual({ m0: 'done', m1: 'in_progress', m2: 'blocked' });
  });
});

describe('renderTimelineMarkdown', () => {
  it('has a header with the map name, generated stamp in the viewer zone, progress and projected end', () => {
    const md = renderTimelineMarkdown(input());
    expect(md).toMatch(/^# Loke-Support — timeline\n/);
    expect(md).toContain('Generated 2026-11-19 08:30 (Europe/Zurich)');
    expect(md).toContain('projected end Fri 18 Dec 2026');
  });

  it('shows the generated stamp on another viewer clock', () => {
    expect(renderTimelineMarkdown(input({ timeZone: 'Asia/Tokyo' }))).toContain('Generated 2026-11-19 16:30 (Asia/Tokyo)');
  });

  it('lists blocked and external leaves under "Waiting on", with who owns them', () => {
    const md = renderTimelineMarkdown(input());
    const m1 = md.slice(md.indexOf('## M1'), md.indexOf('## M2'));
    expect(m1).toContain('**Waiting on**');
    expect(m1).toContain('[AWS VM](https://github.com/loke/support/issues/12) — Owner: LOKE IT (Peter). Needs a t3.medium in eu-central-1.');
    expect(m1).not.toContain('More internal notes');
    const m2 = md.slice(md.indexOf('## M2'));
    expect(m2).toContain('**Zendesk credentials** — Waiting on LOKE support lead for an API token');
    // The waiting leaves are not repeated as open work.
    expect(m1.slice(m1.indexOf('**Still to do**'))).not.toContain('AWS VM');
    expect(m1).toContain('- [Deploy pipeline](https://github.com/loke/support/issues/13)');
  });

  it('summarises milestones in a table at the top', () => {
    const md = renderTimelineMarkdown(input());
    const table = md.slice(md.indexOf('| Milestone'), md.indexOf('## '));
    expect(table).toContain('| M0 Discovery | Done | done Fri 9 Oct 2026 | — |');
    expect(table).toContain('| M1 Infrastructure | In progress (');
    expect(table).toContain('Mon 16 Nov 2026 → Fri 27 Nov 2026 | AWS VM |');
    expect(table).toContain('| M2 Zendesk | Blocked (0%) | Mon 30 Nov 2026 → Fri 18 Dec 2026 | Zendesk credentials |');
  });

  it('collapses a done milestone to one line plus what was delivered', () => {
    const md = renderTimelineMarkdown(input());
    const m0 = md.slice(md.indexOf('## M0'), md.indexOf('## M1'));
    expect(m0).toBe('## M0 Discovery — done\n\nDone Fri 9 Oct 2026. Delivered: Interview support team, Map ticket flows, Write findings.\n\n');
  });

  it('caps the delivered list', () => {
    const md = renderTimelineMarkdown(input({ deliveredCap: 2 }));
    expect(md).toContain('Delivered: Interview support team, Map ticket flows, +1 more.');
  });

  it('summary detail leaves out node ids and effort', () => {
    const md = renderTimelineMarkdown(input({ detail: 'summary' }));
    for (const id of ['root', 'm0', 'm1', 'm2', 'vm', 'deploy', 'creds', 'sync']) {
      expect(md).not.toContain(`\`${id}\``);
    }
    expect(md).not.toMatch(/effort/i);
    expect(md).not.toMatch(/\b\d+ d\b/);
  });

  it('full detail adds ids and effort', () => {
    const md = renderTimelineMarkdown(input({ detail: 'full' }));
    expect(md).toContain('`m1`');
    expect(md).toContain('`vm`');
    expect(md).toContain('effort 6 d');
    expect(md).toContain('[Deploy pipeline](https://github.com/loke/support/issues/13) (4 d, 50%, `deploy`)');
  });

  it('renders one subtree, titled after it', () => {
    const md = renderTimelineMarkdown(input({ rootNodeId: 'm1' }));
    expect(md).toMatch(/^# Loke-Support — M1 Infrastructure — timeline/);
    // Leaves of a subtree root are its sections.
    expect(md).toContain('## AWS VM');
  });

  it('escapes pipes in table cells and puts the preface under the title', () => {
    const ns = nodes();
    ns.find((n) => n.id === 'm2')!.text = 'M2 Zendesk | Freshdesk';
    const md = renderTimelineMarkdown(input({ nodes: ns, preface: ['> Read-only copy.'] }));
    expect(md).toContain('| M2 Zendesk \\| Freshdesk |');
    expect(md).toMatch(/^# Loke-Support — timeline\n\n> Read-only copy.\n/);
  });

  it('formats calendar days without a zone shift', () => {
    expect(formatTimelineDay('2026-12-31')).toBe('Thu 31 Dec 2026');
  });
});

describe('waits with a lead time (#654)', () => {
  it('a lead-time leaf is waiting: who, when asked, and when it is expected', () => {
    const withWait = nodes().map((n) =>
      n.id === 'vm' ? { ...n, tags: [], leadTime: 5, waitingOn: 'LOKE IT', requestedAt: '2026-11-16', effortEstimate: null } : n,
    );
    const s = new Map(spans);
    s.set('vm', { start: '2026-11-16', end: '2026-11-20' });
    const m1 = timelineMilestones(input({ nodes: withWait, spans: s })).find((m) => m.node.id === 'm1')!;
    expect(m1.waiting.map((w) => w.node.id)).toEqual(['vm']);
    expect(m1.waiting[0].note).toMatch(/^waiting on LOKE IT, asked Mon 16 Nov 2026, expected Fri 20 Nov 2026/);
    expect(renderTimelineMarkdown(input({ nodes: withWait, spans: s }))).toContain('waiting on LOKE IT, asked Mon 16 Nov 2026');
  });
});
