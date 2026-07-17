import type { Node as CoreNode, MindMap, ComputedNodeValues, NodeId } from '@mindblown/core';
import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
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
  status: string;
  aufwand: string;
  rest: string;
  /** e.g. "D. Haas ✓ 15.07." — one entry per active acceptance, ⚠-suffixed when stale. */
  abnahme: string[];
}

export interface RegisterData {
  title: string;
  generatedAt: string; // YYYY-MM-DD
  total: number;
  counts: { Umgesetzt: number; Teilweise: number; Offen: number };
  chapters: Array<{ name: string; rows: RegisterRow[] }>;
}

const PRIO: Record<string, string> = { must: 'Muss', should: 'Soll', could: 'Kann' };

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
): RegisterData {
  const accByNode = new Map<string, Array<AcceptanceInfo & { nodeId: string }>>();
  for (const a of acceptances) {
    (accByNode.get(a.nodeId) ?? accByNode.set(a.nodeId, []).get(a.nodeId)!).push(a);
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const requirements = nodes.filter((n) => n.requirementId != null);

  const progressOf = (n: CoreNode): number =>
    n.childrenIds.length > 0
      ? (computed.get(n.id)?.computedProgress ?? 0)
      : (n.percentComplete ?? 0);
  const statusOf = (p: number): string =>
    p >= 99.5 ? 'Umgesetzt' : p > 0 ? 'Teilweise' : 'Offen';

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
            status,
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
    counts,
    chapters: orderedChapters,
  };
}

// ── Markdown renderer ─────────────────────────────────────────────

const LEGEND = [
  '**Priorität:** Muss — Kernfunktion (MVP) · Soll — wichtig, nicht MVP-blockierend · Kann — wünschenswert',
  '**Status:** Umgesetzt · Teilweise · Offen (abgeleitet: 100 % / >0 % / 0 % Fortschritt)',
  '**Aufwand** (Gesamt-Referenz) und **Rest** (verbleibend; «—» bei Umgesetzt): **S** ≤ 2 Tage · **M** 3–5 Tage · **L** 1–3 Wochen · **XL** > 3 Wochen',
  '**Abnahme:** ✓ abgenommen · ✗ abgelehnt (mit Begründung) · ⚠ seit dem Urteil geändert',
];

export function renderMarkdown(data: RegisterData): string {
  const L: string[] = [];
  L.push(`# ${data.title}`);
  L.push('');
  L.push(
    `*Generiert aus MindBlown am ${data.generatedAt} — Status abgeleitet aus dem Projektstand (Rollup), nicht manuell gepflegt.*`,
  );
  for (const line of LEGEND) {
    L.push('');
    L.push(line);
  }
  L.push('');
  L.push(
    `**Stand:** ${data.total} Anforderungen — ${data.counts.Umgesetzt} Umgesetzt · ${data.counts.Teilweise} Teilweise · ${data.counts.Offen} Offen`,
  );
  L.push('');
  L.push('---');
  data.chapters.forEach((ch, i) => {
    L.push('');
    L.push(`## ${i + 1}. ${ch.name}`);
    L.push('');
    L.push('| ID | Anforderung | Priorität | Status | Aufwand | Rest | Abnahme |');
    L.push('|---|---|---|---|---|---|---|');
    for (const r of ch.rows) {
      L.push(
        `| ${r.id} | ${r.text.replace(/\|/g, '\\|')} | ${r.prio} | ${r.status} | ${r.aufwand} | ${r.rest} | ${r.abnahme.join(' · ') || '—'} |`,
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

// Column widths as % of table width: ID, Anforderung, Priorität, Status,
// Aufwand, Rest, Abnahme. LibreOffice ignores percentage widths that only
// sit on header cells — the table needs an explicit grid (columnWidths, in
// DXA) and fixed layout, and every cell must carry its column width.
const COL_PCT = [9, 43, 9, 11, 7, 7, 14];
// Usable A4 portrait width with the docx default 1440-twip margins.
const TABLE_DXA = 11906 - 2 * 1440;
const COL_DXA = COL_PCT.map((p) => Math.round((TABLE_DXA * p) / 100));

function cell(text: string, opts: { bold?: boolean; fill?: string; width?: number } = {}): TableCell {
  return new TableCell({
    shading: opts.fill ? { fill: opts.fill } : undefined,
    width: opts.width ? { size: opts.width, type: WidthType.PERCENTAGE } : undefined,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: [
      new Paragraph({
        children: [new TextRun({ text, bold: opts.bold ?? false, size: 18 })],
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
      spacing: { before: 160, after: 240 },
      children: [
        new TextRun({
          text: `Stand: ${data.total} Anforderungen — ${data.counts.Umgesetzt} Umgesetzt · ${data.counts.Teilweise} Teilweise · ${data.counts.Offen} Offen`,
          bold: true,
          size: 20,
        }),
      ],
    }),
  );

  data.chapters.forEach((ch, i) => {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 320, after: 120 },
        children: [new TextRun(`${i + 1}. ${ch.name}`)],
      }),
    );
    const header = new TableRow({
      tableHeader: true,
      children: [
        cell('ID', { bold: true, fill: 'e2e8f0', width: COL_PCT[0] }),
        cell('Anforderung', { bold: true, fill: 'e2e8f0', width: COL_PCT[1] }),
        cell('Priorität', { bold: true, fill: 'e2e8f0', width: COL_PCT[2] }),
        cell('Status', { bold: true, fill: 'e2e8f0', width: COL_PCT[3] }),
        cell('Aufwand', { bold: true, fill: 'e2e8f0', width: COL_PCT[4] }),
        cell('Rest', { bold: true, fill: 'e2e8f0', width: COL_PCT[5] }),
        cell('Abnahme', { bold: true, fill: 'e2e8f0', width: COL_PCT[6] }),
      ],
    });
    const rows = ch.rows.map(
      (r) =>
        new TableRow({
          children: [
            cell(r.id, { bold: true, width: COL_PCT[0] }),
            cell(r.text, { width: COL_PCT[1] }),
            cell(r.prio, { width: COL_PCT[2] }),
            cell(r.status, { fill: STATUS_FILL[r.status], width: COL_PCT[3] }),
            cell(r.aufwand, { width: COL_PCT[4] }),
            cell(r.rest, { width: COL_PCT[5] }),
            cell(r.abnahme.join('\n') || '—', { width: COL_PCT[6] }),
          ],
        }),
    );
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

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}
