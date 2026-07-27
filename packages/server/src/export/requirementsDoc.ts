import type {
  Node as CoreNode,
  MindMap,
  ComputedNodeValues,
  NodeId,
  Version,
} from '@mindblown/core';
import { compareVersions } from '@mindblown/core';
import {
  Document,
  HeadingLevel,
  Packer,
  PageOrientation,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
  BorderStyle,
  TableLayoutType,
} from 'docx';

// ── Register data (shared by both renderers) ─────────────────────

export interface AcceptanceInfo {
  userId: string;
  userName: string;
  acceptedAt: string; // ISO
  progressAtAcceptance: number;
  nodeRevisionAtAcceptance: number;
  /** Verdict — optional so pre-decision callers/rows read as 'accepted'. */
  decision?: 'accepted' | 'rejected';
  /** Reviewer comment; always present on rejections. */
  comment?: string | null;
}

/**
 * An acceptance is stale when the requirement changed materially after
 * sign-off: derived progress moved by more than one point, or the node
 * itself was edited (revision bump). Pure — shared by export, MCP
 * overview and (conceptually) the register UI.
 */
export function acceptanceIsStale(
  acc: AcceptanceInfo,
  currentProgress: number,
  currentRevision: number,
): boolean {
  if (Math.abs(currentProgress - acc.progressAtAcceptance) > 1) return true;
  return currentRevision !== acc.nodeRevisionAtAcceptance;
}

export interface RegisterRow {
  id: string;
  text: string;
  prio: string;
  /** Version name, "↳ V2" when inherited from the work below, "—" when unscheduled. */
  release: string;
  status: string;
  /** Status with the derived percentage on partial rows, e.g. "Teilweise · 42 %". */
  statusDetail: string;
  /** Derived progress 0–100, rounded — feeds the docx progress bar. */
  progress: number;
  aufwand: string;
  rest: string;
  /** e.g. "D. Haas ✓ 15.07." — one entry per active acceptance, ⚠-suffixed when stale. */
  abnahme: string[];
}

export interface RegisterData {
  title: string;
  generatedAt: string; // YYYY-MM-DD
  total: number;
  /** Requirement count before filtering — equals `total` on an unfiltered export. */
  totalAll: number;
  /** Human-readable description of the active filter, null when unfiltered. */
  filterLabel: string | null;
  counts: { Umgesetzt: number; Teilweise: number; Offen: number };
  chapters: Array<{ name: string; rows: RegisterRow[] }>;
}

/**
 * Mirror of the Requirements view's filter bar, so "Export" gives you the
 * document for exactly what's on screen. Semantics match RequirementsView's
 * `filteredRows` predicate one for one.
 */
export interface RegisterFilter {
  status?: 'open' | 'partial' | 'done';
  priority?: 'must' | 'should' | 'could';
  /** A version id, or 'none' for "no release anywhere in the subtree". */
  release?: string;
  /** cumulative = due by this release or earlier; exact = only this release. */
  releaseMode?: 'cumulative' | 'exact';
  hideDone?: boolean;
  acceptance?: 'none' | 'mine-open' | 'rejected';
  /** Needed by acceptance: 'mine-open' — whose verdict counts as "mine". */
  currentUserId?: string | null;
}

const PRIO: Record<string, string> = { must: 'Muss', should: 'Soll', could: 'Kann' };
const STATUS_DE: Record<string, string> = { open: 'Offen', partial: 'Teilweise', done: 'Umgesetzt' };

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

// Doc buckets: S ≤ 2 Tage · M 3–5 · L 1–3 Wochen · XL > 3 Wochen
function sizeOf(days: number): string {
  return days <= 0 ? '—' : days <= 2 ? 'S' : days <= 5 ? 'M' : days <= 15 ? 'L' : 'XL';
}

export function buildRegisterData(
  map: MindMap,
  nodes: CoreNode[],
  computed: Map<NodeId, ComputedNodeValues>,
  acceptances: Array<AcceptanceInfo & { nodeId: string }> = [],
  versions: Version[] = [],
  filter: RegisterFilter = {},
): RegisterData {
  const accByNode = new Map<string, Array<AcceptanceInfo & { nodeId: string }>>();
  for (const a of acceptances) {
    (accByNode.get(a.nodeId) ?? accByNode.set(a.nodeId, []).get(a.nodeId)!).push(a);
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const allRequirements = nodes.filter((n) => n.requirementId != null);

  const progressOf = (n: CoreNode): number =>
    n.childrenIds.length > 0
      ? (computed.get(n.id)?.computedProgress ?? 0)
      : (n.percentComplete ?? 0);
  const statusEnOf = (p: number): 'open' | 'partial' | 'done' =>
    p >= 99.5 ? 'done' : p > 0 ? 'partial' : 'open';
  const statusOf = (p: number): string => STATUS_DE[statusEnOf(p)];

  // A requirement is usually scheduled through its children, not directly —
  // and can be split across releases, so this is a full descendant walk.
  const descendantVersionsOf = (n: CoreNode): string[] => {
    const below = new Set<string>();
    const stack = [...n.childrenIds];
    while (stack.length) {
      const c = byId.get(stack.pop()!);
      if (!c) continue;
      if (c.versionId) below.add(c.versionId);
      stack.push(...c.childrenIds);
    }
    return [...below];
  };

  // Release label, mirroring the register UI: the version tagged on the
  // requirement itself, else the one(s) carried by the work below it.
  const versionName = new Map(versions.map((v) => [v.id, v.name]));
  const releaseOf = (n: CoreNode): string => {
    if (n.versionId) return versionName.get(n.versionId) ?? '—';
    const below = descendantVersionsOf(n);
    if (below.length === 0) return '—';
    if (below.length === 1) return `↳ ${versionName.get(below[0]) ?? '—'}`;
    return `↳ ${below.length} Releases`;
  };

  // Release order for the cumulative ("due by V1") mode.
  const versionRank = new Map(
    [...versions].sort(compareVersions).map((v, i) => [v.id, i] as const),
  );

  const matchesFilter = (n: CoreNode): boolean => {
    const st = statusEnOf(progressOf(n));
    if (filter.hideDone && st === 'done') return false;
    if (filter.status && st !== filter.status) return false;
    if (filter.priority && n.requirementPriority !== filter.priority) return false;
    if (filter.release === 'none') {
      // "No release" means nothing below it is scheduled either.
      if (n.versionId || descendantVersionsOf(n).length > 0) return false;
    } else if (filter.release) {
      if (filter.releaseMode === 'exact') {
        // A split requirement matches every release it touches.
        if (n.versionId !== filter.release && !descendantVersionsOf(n).includes(filter.release)) {
          return false;
        }
      } else {
        const selectedRank = versionRank.get(filter.release);
        if (selectedRank == null) return false;
        const ownRank = n.versionId ? versionRank.get(n.versionId) : undefined;
        const touchesUpToHere =
          (ownRank != null && ownRank <= selectedRank) ||
          descendantVersionsOf(n).some((id) => {
            const rank = versionRank.get(id);
            return rank != null && rank <= selectedRank;
          });
        if (!touchesUpToHere) return false;
      }
    }
    if (filter.acceptance) {
      const accs = accByNode.get(n.id) ?? [];
      if (filter.acceptance === 'none' && accs.length > 0) return false;
      if (
        filter.acceptance === 'mine-open' &&
        accs.some((a) => a.userId === filter.currentUserId)
      ) {
        return false;
      }
      if (filter.acceptance === 'rejected' && !accs.some((a) => a.decision === 'rejected')) {
        return false;
      }
    }
    return true;
  };

  const requirements = allRequirements.filter(matchesFilter);

  // Spell the filter out in the document itself: a filtered Auszug that
  // looks like the complete Anforderungsdokument is worse than no export.
  const filterParts: string[] = [];
  if (filter.release === 'none') filterParts.push('Release: ohne Zuordnung');
  else if (filter.release) {
    filterParts.push(
      `Release: ${filter.releaseMode === 'exact' ? 'nur' : 'bis'} ${versionName.get(filter.release) ?? filter.release}`,
    );
  }
  if (filter.status) filterParts.push(`Status: ${STATUS_DE[filter.status]}`);
  if (filter.hideDone) filterParts.push('ohne Umgesetzte');
  if (filter.priority) filterParts.push(`Priorität: ${PRIO[filter.priority]}`);
  if (filter.acceptance === 'none') filterParts.push('Abnahme: ohne Urteil');
  if (filter.acceptance === 'mine-open') filterParts.push('Abnahme: eigenes Urteil ausstehend');
  if (filter.acceptance === 'rejected') filterParts.push('Abnahme: abgelehnt');
  const filterLabel = filterParts.length > 0 ? filterParts.join(' · ') : null;

  // Depth-first order for chapter (= parent) sorting.
  const dfs = new Map<string, number>();
  {
    let i = 0;
    const walk = (id: string) => {
      dfs.set(id, i++);
      for (const c of byId.get(id)?.childrenIds ?? []) if (byId.has(c)) walk(c);
    };
    walk(map.rootNodeId);
  }

  const chapters = new Map<string, CoreNode[]>();
  for (const n of requirements) {
    const key = n.parentId ?? map.rootNodeId;
    (chapters.get(key) ?? chapters.set(key, []).get(key)!).push(n);
  }

  const counts = { Umgesetzt: 0, Teilweise: 0, Offen: 0 };
  for (const n of requirements) counts[statusOf(progressOf(n)) as keyof typeof counts]++;

  const orderedChapters = [...chapters.entries()]
    .sort((a, b) => (dfs.get(a[0]) ?? Infinity) - (dfs.get(b[0]) ?? Infinity))
    .map(([chapterId, list]) => ({
      name: byId.get(chapterId)?.text ?? '(Root)',
      rows: list
        .sort((a, b) =>
          (a.requirementId ?? '').localeCompare(b.requirementId ?? '', undefined, {
            numeric: true,
          }),
        )
        .map((n) => {
          const p = progressOf(n);
          const status = statusOf(p);
          const effort = computed.get(n.id)?.computedEffort ?? n.effortEstimate ?? 0;
          const abnahme = (accByNode.get(n.id) ?? []).map((a) => {
            const d = a.acceptedAt.slice(5, 10).split('-').reverse().join('.');
            const stale = acceptanceIsStale(a, p, n.revision) ? ' ⚠' : '';
            if (a.decision === 'rejected') {
              const why = a.comment ? ` («${truncate(a.comment, 60)}»)` : '';
              return `${a.userName} ✗ ${d}.${why}${stale}`;
            }
            return `${a.userName} ✓ ${d}.${stale}`;
          });
          return {
            id: n.requirementId ?? '',
            text: (n.requirementText ?? n.text).replace(/\n/g, ' '),
            prio: PRIO[n.requirementPriority ?? ''] ?? '—',
            release: releaseOf(n),
            status,
            // "Teilweise" alone reads the same at 5 % and 95 % — the number
            // is the whole point of a derived status.
            statusDetail: status === 'Teilweise' ? `${status} · ${Math.round(p)} %` : status,
            progress: Math.round(p),
            aufwand: sizeOf(effort),
            rest: status === 'Umgesetzt' ? '—' : sizeOf(effort * (1 - p / 100)),
            abnahme,
          };
        }),
    }));

  return {
    title: `${map.name} — Anforderungsdokument`,
    generatedAt: new Date().toISOString().slice(0, 10),
    total: requirements.length,
    totalAll: allRequirements.length,
    filterLabel,
    counts,
    chapters: orderedChapters,
  };
}

// ── Markdown renderer ─────────────────────────────────────────────

const LEGEND = [
  '**Priorität:** Muss — Kernfunktion (MVP) · Soll — wichtig, nicht MVP-blockierend · Kann — wünschenswert',
  '**Release:** geplante Version · **↳** = aus den darunterliegenden Arbeitspaketen abgeleitet · «—» noch keiner Version zugeordnet',
  '**Status:** Umgesetzt · Teilweise (mit Fortschritt) · Offen (abgeleitet: 100 % / >0 % / 0 % Fortschritt)',
  '**Aufwand** (Gesamt-Referenz) und **Rest** (verbleibend; «—» bei Umgesetzt): **S** ≤ 2 Tage · **M** 3–5 Tage · **L** 1–3 Wochen · **XL** > 3 Wochen',
  '**Abnahme:** ✓ abgenommen · ✗ abgelehnt (mit Begründung) · ⚠ seit dem Urteil geändert',
];

/**
 * The header used to read "Stand: 44 von 163 Anforderungen — 12 Umgesetzt …",
 * which readers took as "44 of 163 done". Scope (how much of the register this
 * document covers) and Stand (how far that scope is along) are two different
 * numbers, so they get two lines. Markers are stripped for the docx renderer.
 */
function scopeLine(data: RegisterData): string {
  return data.filterLabel
    ? `**Umfang:** ${data.total} der insgesamt ${data.totalAll} Anforderungen dieses Projekts — gefilterter Auszug (${data.filterLabel})`
    : `**Umfang:** alle ${data.totalAll} Anforderungen dieses Projekts`;
}

function standLine(data: RegisterData): string {
  const subject = data.total === 1 ? 'dieser Anforderung' : `dieser ${data.total} Anforderungen`;
  return `**Stand ${subject}:** ${data.counts.Umgesetzt} Umgesetzt · ${data.counts.Teilweise} Teilweise · ${data.counts.Offen} Offen`;
}

export function renderMarkdown(data: RegisterData): string {
  const L: string[] = [];
  L.push(`# ${data.title}`);
  L.push('');
  L.push(
    `*Generiert aus MindBlown am ${data.generatedAt} — Status abgeleitet aus dem Projektstand (Rollup), nicht manuell gepflegt.*`,
  );
  if (data.filterLabel) {
    L.push('');
    L.push(`**Gefilterter Auszug** — ${data.filterLabel}. Nicht das vollständige Dokument.`);
  }
  for (const line of LEGEND) {
    L.push('');
    L.push(line);
  }
  L.push('');
  L.push(scopeLine(data));
  L.push('');
  L.push(standLine(data));
  L.push('');
  L.push('---');
  data.chapters.forEach((ch, i) => {
    L.push('');
    L.push(`## ${i + 1}. ${ch.name}`);
    L.push('');
    L.push('| ID | Anforderung | Priorität | Release | Status | Aufwand | Rest | Abnahme |');
    L.push('|---|---|---|---|---|---|---|---|');
    for (const r of ch.rows) {
      L.push(
        `| ${r.id} | ${r.text.replace(/\|/g, '\\|')} | ${r.prio} | ${r.release} | ${r.statusDetail} | ${r.aufwand} | ${r.rest} | ${r.abnahme.join(' · ') || '—'} |`,
      );
    }
  });
  L.push('');
  return L.join('\n');
}

// ── DOCX renderer ─────────────────────────────────────────────────

const STATUS_FILL: Record<string, string> = {
  Umgesetzt: 'd1fae5',
  Teilweise: 'fef3c7',
  Offen: 'f1f5f9',
};

/** Subtle alternate-row fill, mirroring the register UI's hover tone. */
const ZEBRA_FILL = 'f8fafc';

// Column widths as % of table width: ID, Anforderung, Priorität, Release,
// Status, Fortschritt, Aufwand, Rest, Abnahme. LibreOffice ignores
// percentage widths that only sit on header cells — the table needs an
// explicit grid (columnWidths, in DXA) and fixed layout, and every cell
// must carry its column width. Fortschritt is sized so bar + percentage
// stay on ONE line, Aufwand/Rest so their headers don't wrap.
const COL_PCT = [7, 33, 6, 8, 10, 12, 6, 6, 12];
// Usable A4 LANDSCAPE width with 2 cm (1134 twip) margins.
const PAGE_MARGIN = 1134;
const TABLE_DXA = 16838 - 2 * PAGE_MARGIN;
const COL_DXA = COL_PCT.map((p) => Math.round((TABLE_DXA * p) / 100));

/**
 * Text progress bar for the Fortschritt column — the docx stand-in for the
 * register UI's bar. Block glyphs are equal-width in Calibri, so the bars
 * align across rows without a monospace font. Non-breaking spaces keep the
 * percentage on the same line as the bar — with a regular space Word wraps
 * it below and doubles every row's height.
 */
function progressBar(percent: number): { text: string; color: string } {
  const clamped = Math.min(100, Math.max(0, percent));
  const filled = Math.round(clamped / 12.5);
  return {
    text: `${'█'.repeat(filled)}${'░'.repeat(8 - filled)} ${clamped} %`,
    color: clamped >= 100 ? '10b981' : clamped > 0 ? '3b82f6' : '94a3b8',
  };
}

function cell(
  text: string,
  opts: { bold?: boolean; fill?: string; width?: number; color?: string } = {},
): TableCell {
  return new TableCell({
    shading: opts.fill ? { fill: opts.fill } : undefined,
    width: opts.width ? { size: opts.width, type: WidthType.PERCENTAGE } : undefined,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    verticalAlign: VerticalAlign.CENTER,
    children: [
      new Paragraph({
        children: [
          new TextRun({ text, bold: opts.bold ?? false, size: 18, color: opts.color }),
        ],
      }),
    ],
  });
}

export async function renderDocx(data: RegisterData): Promise<Buffer> {
  const children: Array<Paragraph | Table> = [];

  children.push(
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(data.title)] }),
    new Paragraph({
      children: [
        new TextRun({
          text: `Generiert aus MindBlown am ${data.generatedAt} — Status abgeleitet aus dem Projektstand (Rollup), nicht manuell gepflegt.`,
          italics: true,
          size: 18,
        }),
      ],
    }),
  );
  if (data.filterLabel) {
    children.push(
      new Paragraph({
        spacing: { before: 120 },
        children: [
          new TextRun({
            text: `Gefilterter Auszug — ${data.filterLabel}. Nicht das vollständige Dokument.`,
            bold: true,
            size: 18,
          }),
        ],
      }),
    );
  }
  for (const line of LEGEND) {
    // Strip the markdown bold markers for the docx paragraphs.
    children.push(
      new Paragraph({
        children: [new TextRun({ text: line.replace(/\*\*/g, ''), size: 18 })],
        spacing: { before: 120 },
      }),
    );
  }
  children.push(
    new Paragraph({
      spacing: { before: 160 },
      children: [
        new TextRun({ text: scopeLine(data).replace(/\*\*/g, ''), bold: true, size: 20 }),
      ],
    }),
    new Paragraph({
      spacing: { before: 60, after: 240 },
      children: [
        new TextRun({ text: standLine(data).replace(/\*\*/g, ''), bold: true, size: 20 }),
      ],
    }),
  );

  data.chapters.forEach((ch, i) => {
    const doneInChapter = ch.rows.filter((r) => r.status === 'Umgesetzt').length;
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 320, after: 120 },
        children: [
          new TextRun(`${i + 1}. ${ch.name}`),
          // Same at-a-glance counts as the register UI's group header rows.
          new TextRun({
            text: `   ${ch.rows.length} Anforderung${ch.rows.length === 1 ? '' : 'en'} · ${doneInChapter} umgesetzt`,
            bold: false,
            size: 18,
            color: '64748b',
          }),
        ],
      }),
    );
    const header = new TableRow({
      tableHeader: true,
      children: [
        cell('ID', { bold: true, fill: 'e2e8f0', width: COL_PCT[0] }),
        cell('Anforderung', { bold: true, fill: 'e2e8f0', width: COL_PCT[1] }),
        cell('Priorität', { bold: true, fill: 'e2e8f0', width: COL_PCT[2] }),
        cell('Release', { bold: true, fill: 'e2e8f0', width: COL_PCT[3] }),
        cell('Status', { bold: true, fill: 'e2e8f0', width: COL_PCT[4] }),
        cell('Fortschritt', { bold: true, fill: 'e2e8f0', width: COL_PCT[5] }),
        cell('Aufwand', { bold: true, fill: 'e2e8f0', width: COL_PCT[6] }),
        cell('Rest', { bold: true, fill: 'e2e8f0', width: COL_PCT[7] }),
        cell('Abnahme', { bold: true, fill: 'e2e8f0', width: COL_PCT[8] }),
      ],
    });
    const rows = ch.rows.map((r, rowIndex) => {
      const zebra = rowIndex % 2 === 1 ? ZEBRA_FILL : undefined;
      const bar = progressBar(r.progress);
      return new TableRow({
        children: [
          cell(r.id, { bold: true, width: COL_PCT[0], fill: zebra }),
          cell(r.text, { width: COL_PCT[1], fill: zebra }),
          cell(r.prio, { width: COL_PCT[2], fill: zebra, bold: r.prio === 'Muss' }),
          cell(r.release, { width: COL_PCT[3], fill: zebra }),
          cell(r.statusDetail, { fill: STATUS_FILL[r.status], width: COL_PCT[4] }),
          cell(bar.text, { width: COL_PCT[5], fill: zebra, color: bar.color }),
          cell(r.aufwand, { width: COL_PCT[6], fill: zebra }),
          cell(r.rest, { width: COL_PCT[7], fill: zebra }),
          cell(r.abnahme.join('\n') || '—', { width: COL_PCT[8], fill: zebra }),
        ],
      });
    });
    children.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        columnWidths: COL_DXA,
        layout: TableLayoutType.FIXED,
        borders: {
          top: { style: BorderStyle.SINGLE, size: 2, color: 'cbd5e1' },
          bottom: { style: BorderStyle.SINGLE, size: 2, color: 'cbd5e1' },
          left: { style: BorderStyle.SINGLE, size: 2, color: 'cbd5e1' },
          right: { style: BorderStyle.SINGLE, size: 2, color: 'cbd5e1' },
          insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: 'e2e8f0' },
          insideVertical: { style: BorderStyle.SINGLE, size: 2, color: 'e2e8f0' },
        },
        rows: [header, ...rows],
      }),
    );
  });

  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            // A4 landscape — 8 columns plus a progress bar don't breathe in
            // portrait. docx swaps width/height for LANDSCAPE, so pass the
            // portrait A4 dimensions here.
            size: { width: 11906, height: 16838, orientation: PageOrientation.LANDSCAPE },
            margin: {
              top: PAGE_MARGIN,
              right: PAGE_MARGIN,
              bottom: PAGE_MARGIN,
              left: PAGE_MARGIN,
            },
          },
        },
        children,
      },
    ],
  });
  return Packer.toBuffer(doc);
}
