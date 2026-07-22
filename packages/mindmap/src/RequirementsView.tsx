import { useEffect, useMemo, useState } from 'react';
import { compareVersions } from '@mindblown/core';
import type { Node, Version } from '@mindblown/core';
import { useMindmapStore } from './store.js';
import * as api from './api.js';

// ── Derived requirement status ───────────────────────────────────
//
// Never stored — always derived from progress rollup so the register
// can't drift from the plan (the whole point of the feature).

type ReqStatus = 'open' | 'partial' | 'done';

const STATUS_LABEL: Record<ReqStatus, string> = {
  done: 'Done',
  partial: 'Partial',
  open: 'Open',
};

const STATUS_COLOR: Record<ReqStatus, { bg: string; fg: string }> = {
  done: { bg: '#d1fae5', fg: '#065f46' },
  partial: { bg: '#fef3c7', fg: '#92400e' },
  open: { bg: '#f1f5f9', fg: '#475569' },
};

const HEALTH_COLOR: Record<string, string> = {
  on_track: '#10b981',
  at_risk: '#f59e0b',
  behind: '#ef4444',
};

const PRIORITY_LABEL: Record<string, string> = {
  must: 'Must',
  should: 'Should',
  could: 'Could',
};

interface ReqRow {
  node: Node;
  chapterId: string | null;
  chapterText: string;
  isLeaf: boolean;
  progress: number;
  status: ReqStatus;
  remaining: number;
  unestimated: number;
  health: string;
  ghLinks: Array<{ id: string; url: string }>;
  /** Version set on the requirement node itself. */
  versionId: string | null;
  /** Distinct versions found below it — the requirement may be split across releases. */
  descendantVersionIds: string[];
  /** What the register treats as "the" release: own, else a unanimous descendant one. */
  effectiveVersionId: string | null;
}

function statusOf(progress: number): ReqStatus {
  return progress >= 100 ? 'done' : progress > 0 ? 'partial' : 'open';
}

function compareReqIds(a: ReqRow, b: ReqRow): number {
  return (a.node.requirementId ?? '').localeCompare(b.node.requirementId ?? '', undefined, {
    numeric: true,
  });
}

// ── Component ────────────────────────────────────────────────────

export function RequirementsView() {
  const nodes = useMindmapStore((s) => s.nodes);
  const currentMapId = useMindmapStore((s) => s.currentMapId);
  const rootNodeId = useMindmapStore((s) => s.rootNodeId);
  const computed = useMindmapStore((s) => s.computed);
  const updateNode = useMindmapStore((s) => s.updateNode);
  const addNode = useMindmapStore((s) => s.addNode);
  const selectNode = useMindmapStore((s) => s.selectNode);
  const setFocusNode = useMindmapStore((s) => s.setFocusNode);
  const setActiveView = useMindmapStore((s) => s.setActiveView);
  const effortUnit = useMindmapStore((s) => s.currentMap?.effortUnit ?? 'days');
  const versions = useMindmapStore((s) => s.versions);

  const sortedVersions = useMemo(() => [...versions].sort(compareVersions), [versions]);
  const versionById = useMemo(() => {
    const m = new Map<string, Version>();
    for (const v of versions) m.set(v.id, v);
    return m;
  }, [versions]);

  const user = useMindmapStore((s) => s.user);
  const [acceptances, setAcceptances] = useState<api.AcceptanceRow[]>([]);
  const [acceptanceFilter, setAcceptanceFilter] = useState<'' | 'none' | 'mine-open' | 'rejected'>('');
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (!currentMapId) return;
    let cancelled = false;
    api
      .fetchAcceptances(currentMapId)
      .then((r) => !cancelled && setAcceptances(r.acceptances))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [currentMapId]);

  const accByNode = useMemo(() => {
    const m = new Map<string, api.AcceptanceRow[]>();
    for (const a of acceptances) {
      const list = m.get(a.nodeId) ?? [];
      list.push(a);
      m.set(a.nodeId, list);
    }
    return m;
  }, [acceptances]);

  const [statusFilter, setStatusFilter] = useState<'' | ReqStatus>('');
  const [priorityFilter, setPriorityFilter] = useState<'' | 'must' | 'should' | 'could'>('');
  // '' = all, 'none' = no release (own or inherited), otherwise a versionId
  const [versionFilter, setVersionFilter] = useState<string>('');
  const [editingCell, setEditingCell] = useState<{ nodeId: string; field: string } | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createFields, setCreateFields] = useState({
    chapterId: '',
    requirementId: '',
    text: '',
    requirementPriority: '' as '' | 'must' | 'should' | 'could',
  });

  // Deliberately NOT getVisibleNodes(): the register must show every
  // requirement regardless of canvas focus / collapse / depth limit.
  const allRows = useMemo<ReqRow[]>(() => {
    const countUnestimatedLeaves = (id: string): number => {
      let count = 0;
      const stack = [id];
      while (stack.length) {
        const n = nodes[stack.pop()!];
        if (!n) continue;
        if (n.childrenIds.length === 0) {
          if (n.effortEstimate == null) count++;
        } else {
          stack.push(...n.childrenIds);
        }
      }
      return count;
    };

    const descendantVersions = (id: string): string[] => {
      const found = new Set<string>();
      const stack = [...(nodes[id]?.childrenIds ?? [])];
      while (stack.length) {
        const n = nodes[stack.pop()!];
        if (!n) continue;
        if (n.versionId) found.add(n.versionId);
        stack.push(...n.childrenIds);
      }
      return [...found];
    };

    return Object.values(nodes)
      .filter((n) => n.requirementId != null)
      .map((node) => {
        const cv = computed.get(node.id);
        const descendantVersionIds = descendantVersions(node.id);
        const isLeaf = node.childrenIds.length === 0;
        const progress = isLeaf ? (node.percentComplete ?? 0) : (cv?.computedProgress ?? 0);
        // Chapter = the requirement's parent node. In a doc-shaped map the
        // requirements sit directly under their Bereich node, so the parent
        // IS the chapter; this also matches ListView's group-by-parent.
        const chapter = node.parentId ? nodes[node.parentId] : null;
        return {
          node,
          chapterId: chapter?.id ?? null,
          chapterText: chapter?.text ?? '(root)',
          isLeaf,
          progress,
          status: statusOf(progress),
          remaining: (cv?.computedEffort ?? 0) * (1 - progress / 100),
          unestimated: countUnestimatedLeaves(node.id),
          health: cv?.healthSignal ?? 'on_track',
          ghLinks: node.externalLinks
            .filter((l) => l.provider === 'github')
            .map((l) => ({ id: l.externalId, url: l.url })),
          versionId: node.versionId ?? null,
          descendantVersionIds,
          effectiveVersionId:
            node.versionId ??
            (descendantVersionIds.length === 1 ? descendantVersionIds[0] : null),
        };
      });
  }, [nodes, computed]);

  const totals = useMemo(() => {
    const t = { done: 0, partial: 0, open: 0 };
    for (const r of allRows) t[r.status]++;
    return t;
  }, [allRows]);

  const filteredRows = useMemo(
    () =>
      allRows.filter((r) => {
        if (statusFilter && r.status !== statusFilter) return false;
        if (priorityFilter && r.node.requirementPriority !== priorityFilter) return false;
        if (versionFilter === 'none') {
          // "No release" means nothing below it is scheduled either.
          if (r.versionId || r.descendantVersionIds.length > 0) return false;
        } else if (versionFilter) {
          // A split requirement matches every release it touches.
          if (r.versionId !== versionFilter && !r.descendantVersionIds.includes(versionFilter)) {
            return false;
          }
        }
        if (acceptanceFilter) {
          const accs = accByNode.get(r.node.id) ?? [];
          if (acceptanceFilter === 'none' && accs.length > 0) return false;
          if (acceptanceFilter === 'mine-open' && accs.some((a) => a.userId === user?.id)) {
            return false;
          }
          if (acceptanceFilter === 'rejected' && !accs.some((a) => a.decision === 'rejected')) {
            return false;
          }
        }
        return true;
      }),
    [allRows, statusFilter, priorityFilter, versionFilter, acceptanceFilter, accByNode, user],
  );

  // Depth-first tree order — used to sort chapter groups so the register
  // follows the map's structure (Bereich order in a doc-shaped spine).
  const dfsOrder = useMemo(() => {
    const order = new Map<string, number>();
    if (!rootNodeId) return order;
    let i = 0;
    const walk = (id: string) => {
      order.set(id, i++);
      for (const cid of nodes[id]?.childrenIds ?? []) if (nodes[cid]) walk(cid);
    };
    walk(rootNodeId);
    return order;
  }, [nodes, rootNodeId]);

  // Group by chapter (= parent node) in tree order; requirements within a
  // chapter in REQ-ID order.
  const grouped = useMemo(() => {
    const byChapter = new Map<string, ReqRow[]>();
    for (const r of [...filteredRows].sort(compareReqIds)) {
      const key = r.chapterId ?? '(root)';
      const list = byChapter.get(key) ?? [];
      list.push(r);
      byChapter.set(key, list);
    }
    return [...byChapter.entries()].sort(
      (a, b) => (dfsOrder.get(a[0]) ?? Infinity) - (dfsOrder.get(b[0]) ?? Infinity),
    );
  }, [filteredRows, dfsOrder]);

  // Add-form chapter choices: parents that already hold requirements (the
  // Bereiche once the map is doc-shaped), falling back to root's children
  // on a map with no requirements yet.
  const chapters = useMemo(() => {
    const parentIds = new Set<string>();
    for (const r of allRows) if (r.chapterId) parentIds.add(r.chapterId);
    const list = [...parentIds]
      .map((id) => nodes[id])
      .filter(Boolean)
      .sort((a, b) => (dfsOrder.get(a.id) ?? Infinity) - (dfsOrder.get(b.id) ?? Infinity));
    if (list.length > 0) return list;
    return rootNodeId
      ? (nodes[rootNodeId]?.childrenIds ?? []).map((id) => nodes[id]).filter(Boolean)
      : [];
  }, [allRows, nodes, rootNodeId, dfsOrder]);

  const toggleAcceptance = async (row: ReqRow) => {
    if (!currentMapId || !user) return;
    const mine = (accByNode.get(row.node.id) ?? []).find((a) => a.userId === user.id);
    try {
      if (mine) {
        await api.revokeAcceptance(currentMapId, row.node.id);
        setAcceptances((prev) => prev.filter((a) => a.id !== mine.id));
      } else {
        if (
          row.status !== 'done' &&
          !window.confirm(`Status ist ${STATUS_LABEL[row.status]} — trotzdem abnehmen?`)
        ) {
          return;
        }
        const created = await api.acceptRequirement(currentMapId, row.node.id);
        setAcceptances((prev) => [...prev, created]);
      }
    } catch {
      // Refresh on conflict (e.g. accepted elsewhere) — server state wins.
      api.fetchAcceptances(currentMapId).then((r) => setAcceptances(r.acceptances)).catch(() => {});
    }
  };

  const rejectRequirement = async (row: ReqRow) => {
    if (!currentMapId || !user) return;
    const comment = window.prompt(
      `${row.node.requirementId} ablehnen — warum? (Begründung ist Pflicht)`,
    );
    if (comment == null) return; // cancelled
    if (comment.trim() === '') return;
    try {
      const created = await api.acceptRequirement(currentMapId, row.node.id, {
        decision: 'rejected',
        comment: comment.trim(),
      });
      setAcceptances((prev) => [...prev, created]);
    } catch {
      api.fetchAcceptances(currentMapId).then((r) => setAcceptances(r.acceptances)).catch(() => {});
    }
  };

  const jumpToNode = (node: Node) => {
    setActiveView('mindmap');
    selectNode(node.id);
    const targetFocus = node.parentId && node.parentId !== rootNodeId ? node.parentId : null;
    setFocusNode(targetFocus);
    (window as unknown as { __mindmapPanToNode?: (id: string) => void }).__mindmapPanToNode?.(
      node.id,
    );
  };

  const submitCreate = () => {
    const { chapterId, requirementId, text, requirementPriority } = createFields;
    if (!chapterId || !requirementId.trim() || !text.trim()) return;
    addNode(chapterId, text.trim(), false, undefined, {
      requirementId: requirementId.trim(),
      requirementPriority: requirementPriority || null,
    });
    setCreateFields({ chapterId, requirementId: '', text: '', requirementPriority: '' });
    setShowCreate(false);
  };

  const isEditing = (nodeId: string, field: string) =>
    editingCell?.nodeId === nodeId && editingCell.field === field;

  if (!rootNodeId) {
    return (
      <div style={containerStyle}>
        <EmptyState title="No map open" message="Open a map to see its requirements." />
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      <div style={headerStyle}>
        <div>
          <h2 style={{ margin: 0, fontSize: 16, color: '#1e293b' }}>Requirements</h2>
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
            {allRows.length} requirement{allRows.length === 1 ? '' : 's'} · {totals.done} done ·{' '}
            {totals.partial} partial · {totals.open} open
            {(statusFilter || priorityFilter || versionFilter) &&
              ` · showing ${filteredRows.length} (filtered)`}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as '' | ReqStatus)}
            style={filterSelectStyle}
          >
            <option value="">All statuses</option>
            <option value="open">Open</option>
            <option value="partial">Partial</option>
            <option value="done">Done</option>
          </select>
          <select
            value={priorityFilter}
            onChange={(e) =>
              setPriorityFilter(e.target.value as '' | 'must' | 'should' | 'could')
            }
            style={filterSelectStyle}
          >
            <option value="">All priorities</option>
            <option value="must">Must</option>
            <option value="should">Should</option>
            <option value="could">Could</option>
          </select>
          <select
            value={versionFilter}
            onChange={(e) => setVersionFilter(e.target.value)}
            style={filterSelectStyle}
          >
            <option value="">All releases</option>
            <option value="none">No release</option>
            {sortedVersions.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
          <select
            value={acceptanceFilter}
            onChange={(e) =>
              setAcceptanceFilter(e.target.value as '' | 'none' | 'mine-open' | 'rejected')
            }
            style={filterSelectStyle}
          >
            <option value="">Abnahme: alle</option>
            <option value="none">Nicht abgenommen</option>
            <option value="mine-open">Meine Abnahme offen</option>
            <option value="rejected">Abgelehnt</option>
          </select>
          <button
            onClick={() => setShowCreate((v) => !v)}
            style={primaryButtonStyle(false)}
          >
            + New requirement
          </button>
          <button
            onClick={async () => {
              if (!currentMapId || exporting) return;
              setExporting(true);
              try {
                // Word is what business consumers open — the Markdown
                // variant stays available via ?format=md and the MCP tool.
                const blob = await api.exportRequirementsDocx(currentMapId);
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = `anforderungsdokument-${new Date().toISOString().slice(0, 10)}.docx`;
                a.click();
                URL.revokeObjectURL(a.href);
              } finally {
                setExporting(false);
              }
            }}
            disabled={exporting}
            title="Als Anforderungsdokument (Word) exportieren"
            style={secondaryButtonStyle(exporting)}
          >
            {exporting ? 'Exporting…' : 'Export Word'}
          </button>
        </div>
      </div>

      {showCreate && (
        <div style={createFormStyle}>
          <select
            value={createFields.chapterId}
            onChange={(e) => setCreateFields((f) => ({ ...f, chapterId: e.target.value }))}
            style={{ ...inputStyle, width: 200 }}
          >
            <option value="">Chapter…</option>
            {chapters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.text}
              </option>
            ))}
          </select>
          <input
            placeholder="REQ-ID (e.g. MAN-01)"
            value={createFields.requirementId}
            onChange={(e) => setCreateFields((f) => ({ ...f, requirementId: e.target.value }))}
            style={{ ...inputStyle, width: 150 }}
          />
          <input
            placeholder="Requirement title"
            value={createFields.text}
            onChange={(e) => setCreateFields((f) => ({ ...f, text: e.target.value }))}
            onKeyDown={(e) => e.key === 'Enter' && submitCreate()}
            style={{ ...inputStyle, flex: 1 }}
          />
          <select
            value={createFields.requirementPriority}
            onChange={(e) =>
              setCreateFields((f) => ({
                ...f,
                requirementPriority: e.target.value as '' | 'must' | 'should' | 'could',
              }))
            }
            style={{ ...inputStyle, width: 110 }}
          >
            <option value="">Priority…</option>
            <option value="must">Must</option>
            <option value="should">Should</option>
            <option value="could">Could</option>
          </select>
          <button
            onClick={submitCreate}
            disabled={
              !createFields.chapterId ||
              !createFields.requirementId.trim() ||
              !createFields.text.trim()
            }
            style={primaryButtonStyle(
              !createFields.chapterId ||
                !createFields.requirementId.trim() ||
                !createFields.text.trim(),
            )}
          >
            Create
          </button>
          <button onClick={() => setShowCreate(false)} style={secondaryButtonStyle(false)}>
            Cancel
          </button>
        </div>
      )}

      {allRows.length === 0 ? (
        <EmptyState
          title="No requirements yet"
          message='Mark a node as a requirement by giving it a Requirement ID (property panel), or click "+ New requirement".'
        />
      ) : (
        <div style={{ overflow: 'auto', flex: 1 }}>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={{ ...thStyle, width: 110 }}>ID</th>
                <th style={thStyle}>Requirement</th>
                <th style={{ ...thStyle, width: 80 }}>Priority</th>
                <th style={{ ...thStyle, width: 110 }}>Release</th>
                <th style={{ ...thStyle, width: 80 }}>Status</th>
                <th style={{ ...thStyle, width: 130 }}>Progress</th>
                <th style={{ ...thStyle, width: 130, textAlign: 'right' }}>Remaining</th>
                <th style={{ ...thStyle, width: 140 }}>GitHub</th>
                <th style={{ ...thStyle, width: 170 }}>Abnahme</th>
              </tr>
            </thead>
            <tbody>
              {grouped.map(([chapterKey, rows]) => (
                <ChapterGroup
                  key={chapterKey}
                  chapterText={rows[0].chapterText}
                  rows={rows}
                  effortUnit={effortUnit}
                  sortedVersions={sortedVersions}
                  versionById={versionById}
                  isEditing={isEditing}
                  setEditingCell={setEditingCell}
                  updateNode={updateNode}
                  jumpToNode={jumpToNode}
                  accByNode={accByNode}
                  currentUserId={user?.id ?? null}
                  toggleAcceptance={toggleAcceptance}
                  rejectRequirement={rejectRequirement}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Chapter group (header row + requirement rows) ────────────────

function ChapterGroup({
  chapterText,
  rows,
  effortUnit,
  sortedVersions,
  versionById,
  isEditing,
  setEditingCell,
  updateNode,
  jumpToNode,
  accByNode,
  currentUserId,
  toggleAcceptance,
  rejectRequirement,
}: {
  chapterText: string;
  rows: ReqRow[];
  effortUnit: string;
  sortedVersions: Version[];
  versionById: Map<string, Version>;
  isEditing: (nodeId: string, field: string) => boolean;
  setEditingCell: (cell: { nodeId: string; field: string } | null) => void;
  updateNode: (id: string, updates: Partial<Node>) => void;
  jumpToNode: (node: Node) => void;
  accByNode: Map<string, api.AcceptanceRow[]>;
  currentUserId: string | null;
  toggleAcceptance: (row: ReqRow) => void;
  rejectRequirement: (row: ReqRow) => void;
}) {
  const done = rows.filter((r) => r.status === 'done').length;
  return (
    <>
      <tr>
        <td colSpan={9} style={groupHeaderStyle}>
          {chapterText}
          <span style={{ fontWeight: 400, color: '#64748b', marginLeft: 8 }}>
            {rows.length} req · {done} done
          </span>
        </td>
      </tr>
      {rows.map((r) => (
        <tr
          key={r.node.id}
          onClick={() => jumpToNode(r.node)}
          onMouseEnter={(e) => (e.currentTarget.style.background = '#f8fafc')}
          onMouseLeave={(e) => (e.currentTarget.style.background = '')}
          title="Open in mindmap"
          style={{ borderBottom: '1px solid #f1f5f9', cursor: 'pointer' }}
        >
          {/* REQ-ID — inline editable (stopPropagation so editing doesn't navigate) */}
          <td
            style={tdStyle}
            onClick={(e) => {
              e.stopPropagation();
              setEditingCell({ nodeId: r.node.id, field: 'requirementId' });
            }}
          >
            {isEditing(r.node.id, 'requirementId') ? (
              <input
                autoFocus
                defaultValue={r.node.requirementId ?? ''}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v !== r.node.requirementId) {
                    updateNode(r.node.id, { requirementId: v || null });
                  }
                  setEditingCell(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  if (e.key === 'Escape') setEditingCell(null);
                  e.stopPropagation();
                }}
                style={{ ...inputStyle, width: 90, padding: '2px 6px' }}
              />
            ) : (
              <span style={{ fontWeight: 600, color: '#334155', cursor: 'text' }}>
                {r.node.requirementId}
              </span>
            )}
          </td>

          {/* Title — inline editable (stopPropagation); ↗ is an explicit jump too */}
          <td
            style={tdStyle}
            onClick={(e) => {
              e.stopPropagation();
              setEditingCell({ nodeId: r.node.id, field: 'text' });
            }}
          >
            {isEditing(r.node.id, 'text') ? (
              <input
                autoFocus
                defaultValue={r.node.requirementText ?? r.node.text}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  // Business phrasing edits go to requirementText when one is
                  // set — never touching the (GitHub-synced) node text.
                  if (r.node.requirementText != null) {
                    if (v !== r.node.requirementText) {
                      updateNode(r.node.id, { requirementText: v || null });
                    }
                  } else if (v && v !== r.node.text) {
                    updateNode(r.node.id, { text: v });
                  }
                  setEditingCell(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  if (e.key === 'Escape') setEditingCell(null);
                  e.stopPropagation();
                }}
                style={{ ...inputStyle, width: '100%', padding: '2px 6px' }}
              />
            ) : (
              <span style={{ cursor: 'text' }}>
                <span
                  style={{
                    display: 'inline-block',
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    background: HEALTH_COLOR[r.health] ?? '#94a3b8',
                    marginRight: 8,
                  }}
                  title={`Health: ${r.health}`}
                />
                <span
                  title={
                    r.node.requirementText != null && r.node.requirementText !== r.node.text
                      ? `Node: ${r.node.text}`
                      : undefined
                  }
                >
                  {r.node.requirementText ?? r.node.text}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    jumpToNode(r.node);
                  }}
                  title="Show in mindmap"
                  style={jumpButtonStyle}
                >
                  ↗
                </button>
              </span>
            )}
          </td>

          {/* MoSCoW priority — inline select (stopPropagation so it doesn't navigate) */}
          <td style={tdStyle} onClick={(e) => e.stopPropagation()}>
            <select
              value={r.node.requirementPriority ?? ''}
              onChange={(e) =>
                updateNode(r.node.id, {
                  requirementPriority: (e.target.value || null) as Node['requirementPriority'],
                })
              }
              onKeyDown={(e) => e.stopPropagation()}
              style={inlineSelectStyle}
            >
              <option value="">—</option>
              <option value="must">Must</option>
              <option value="should">Should</option>
              <option value="could">Could</option>
            </select>
          </td>

          {/* Release — own versionId; falls back to what's tagged below it */}
          <td style={tdStyle} onClick={(e) => e.stopPropagation()}>
            <select
              value={r.versionId ?? ''}
              onChange={(e) => updateNode(r.node.id, { versionId: e.target.value || null })}
              onKeyDown={(e) => e.stopPropagation()}
              title={
                r.versionId
                  ? 'Release tagged on this requirement'
                  : r.descendantVersionIds.length === 0
                    ? 'Not scheduled for any release'
                    : `Inherited from work below it: ${r.descendantVersionIds
                        .map((id) => versionById.get(id)?.name ?? '?')
                        .join(', ')}`
              }
              style={{
                ...inlineSelectStyle,
                color: r.versionId ? '#334155' : '#94a3b8',
                fontStyle: r.versionId ? 'normal' : 'italic',
              }}
            >
              <option value="">
                {r.descendantVersionIds.length === 0
                  ? '—'
                  : r.descendantVersionIds.length === 1
                    ? `↳ ${versionById.get(r.descendantVersionIds[0])?.name ?? '?'}`
                    : `↳ ${r.descendantVersionIds.length} releases`}
              </option>
              {sortedVersions.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </td>

          {/* Derived status — read-only by design */}
          <td style={tdStyle}>
            <span
              title="Derived from progress rollup — complete the underlying work to change it"
              style={{
                padding: '2px 8px',
                borderRadius: 10,
                fontSize: 11,
                fontWeight: 600,
                background: STATUS_COLOR[r.status].bg,
                color: STATUS_COLOR[r.status].fg,
              }}
            >
              {STATUS_LABEL[r.status]}
            </span>
          </td>

          {/* Progress — editable on leaves only (parents roll up) */}
          <td
            style={tdStyle}
            onClick={(e) => {
              // Leaves edit in place (stopPropagation); parents fall through to navigate.
              if (r.isLeaf) {
                e.stopPropagation();
                setEditingCell({ nodeId: r.node.id, field: 'percentComplete' });
              }
            }}
          >
            {r.isLeaf && isEditing(r.node.id, 'percentComplete') ? (
              <input
                autoFocus
                type="number"
                min={0}
                max={100}
                defaultValue={r.node.percentComplete ?? 0}
                onBlur={(e) => {
                  const v = e.target.value === '' ? null : Number(e.target.value);
                  updateNode(r.node.id, {
                    percentComplete: v != null ? Math.min(100, Math.max(0, v)) : null,
                  });
                  setEditingCell(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  if (e.key === 'Escape') setEditingCell(null);
                  e.stopPropagation();
                }}
                style={{ ...inputStyle, width: 60, padding: '2px 6px' }}
              />
            ) : (
              <ProgressBar percent={r.progress} editable={r.isLeaf} />
            )}
          </td>

          {/* Remaining effort + unestimated warning */}
          <td style={{ ...tdStyle, textAlign: 'right', whiteSpace: 'nowrap' }}>
            {r.status === 'done' ? (
              <span style={{ color: '#94a3b8' }}>—</span>
            ) : (
              `${r.remaining.toFixed(1)} ${effortUnit}`
            )}
            {r.unestimated > 0 && (
              <span
                title={`${r.unestimated} unestimated leaf/leaves under this requirement — remaining under-counts`}
                style={{ color: '#d97706', marginLeft: 6, cursor: 'help' }}
              >
                ⚠{r.unestimated}
              </span>
            )}
          </td>

          {/* GitHub links */}
          <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>
            {r.ghLinks.length === 0 ? (
              <span style={{ color: '#cbd5e1' }}>—</span>
            ) : (
              r.ghLinks.map((l, i) => (
                <a
                  key={l.id}
                  href={l.url}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  style={{ color: '#3b82f6', textDecoration: 'none', marginLeft: i > 0 ? 6 : 0 }}
                >
                  {l.id.includes('#') ? `#${l.id.split('#')[1]}` : l.id}
                </a>
              ))
            )}
          </td>

          {/* Abnahme — per-user sign-off chips; own chip toggles */}
          <td style={{ ...tdStyle, whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
            {(accByNode.get(r.node.id) ?? []).map((a) => {
              const stale =
                Math.abs(r.progress - a.progressAtAcceptance) > 1 ||
                r.node.revision !== a.nodeRevisionAtAcceptance;
              const own = a.userId === currentUserId;
              const rejected = a.decision === 'rejected';
              const mark = rejected ? '✗' : '✓';
              const label = `${a.userName.split(' ')[0]} ${mark} ${a.acceptedAt.slice(5, 10).split('-').reverse().join('.')}.`;
              return (
                <span
                  key={a.id}
                  onClick={own ? () => toggleAcceptance(r) : undefined}
                  title={
                    (stale ? 'Seit dem Urteil geändert! ' : '') +
                    `${a.userName}, ${rejected ? 'abgelehnt' : 'abgenommen'} ${a.acceptedAt.slice(0, 10)} bei ${Math.round(a.progressAtAcceptance)}%` +
                    (rejected && a.comment ? ` — «${a.comment}»` : '') +
                    (own ? ' — klicken zum Zurückziehen' : '')
                  }
                  style={{
                    display: 'inline-block',
                    padding: '2px 8px',
                    marginRight: 4,
                    borderRadius: 10,
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: own ? 'pointer' : 'default',
                    background: rejected ? '#fee2e2' : stale ? '#fef3c7' : '#d1fae5',
                    color: rejected ? '#991b1b' : stale ? '#92400e' : '#065f46',
                  }}
                >
                  {stale ? '⚠ ' : ''}
                  {label}
                </span>
              );
            })}
            {currentUserId &&
              !(accByNode.get(r.node.id) ?? []).some((a) => a.userId === currentUserId) && (
                <>
                  <button
                    onClick={() => toggleAcceptance(r)}
                    title="Requirement abnehmen (persönliche Abnahme, Status bleibt abgeleitet)"
                    style={{
                      padding: '2px 8px',
                      borderRadius: 10,
                      fontSize: 11,
                      border: '1px dashed #cbd5e1',
                      background: 'transparent',
                      color: '#64748b',
                      cursor: 'pointer',
                    }}
                  >
                    ✓ Abnehmen
                  </button>
                  <button
                    onClick={() => rejectRequirement(r)}
                    title="Requirement ablehnen — Begründung ist Pflicht"
                    style={{
                      padding: '2px 8px',
                      marginLeft: 4,
                      borderRadius: 10,
                      fontSize: 11,
                      border: '1px dashed #fca5a5',
                      background: 'transparent',
                      color: '#b91c1c',
                      cursor: 'pointer',
                    }}
                  >
                    ✗
                  </button>
                </>
              )}
          </td>
        </tr>
      ))}
    </>
  );
}

// ── Small pieces ─────────────────────────────────────────────────

function ProgressBar({ percent, editable }: { percent: number; editable: boolean }) {
  const clamped = Math.min(100, Math.max(0, Math.round(percent)));
  return (
    <div
      style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: editable ? 'text' : 'default' }}
      title={editable ? 'Click to edit (leaf)' : 'Rolled up from children'}
    >
      <div style={{ flex: 1, height: 6, background: '#f1f5f9', borderRadius: 3, minWidth: 50 }}>
        <div
          style={{
            width: `${clamped}%`,
            height: '100%',
            borderRadius: 3,
            background: clamped >= 100 ? '#10b981' : '#3b82f6',
          }}
        />
      </div>
      <span style={{ fontSize: 11, color: '#64748b', minWidth: 32, textAlign: 'right' }}>
        {clamped}%
      </span>
    </div>
  );
}

function EmptyState({ title, message }: { title: string; message: string }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        flex: 1,
        padding: 40,
        color: '#64748b',
        textAlign: 'center',
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 600, color: '#1e293b', marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 12, maxWidth: 420 }}>{message}</div>
    </div>
  );
}

// ── Styles ───────────────────────────────────────────────────────

const containerStyle: React.CSSProperties = {
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  background: '#ffffff',
  fontFamily: 'inherit',
};

const headerStyle: React.CSSProperties = {
  padding: '16px 24px',
  borderBottom: '1px solid #e2e8f0',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
};

const createFormStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  padding: '12px 24px',
  borderBottom: '1px solid #e2e8f0',
  background: '#f8fafc',
  alignItems: 'center',
};

const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 12,
};

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '10px 16px',
  fontSize: 10,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  color: '#64748b',
  borderBottom: '1px solid #e2e8f0',
  background: '#f8fafc',
  position: 'sticky',
  top: 0,
  zIndex: 1,
};

const tdStyle: React.CSSProperties = {
  padding: '8px 16px',
  fontSize: 12,
  color: '#334155',
  verticalAlign: 'middle',
};

const groupHeaderStyle: React.CSSProperties = {
  padding: '10px 16px',
  fontSize: 12,
  fontWeight: 600,
  color: '#3730a3',
  background: '#eef2ff',
  borderBottom: '1px solid #e0e7ff',
};

const inputStyle: React.CSSProperties = {
  boxSizing: 'border-box',
  padding: '6px 10px',
  fontSize: 12,
  fontFamily: 'inherit',
  border: '1px solid #cbd5e1',
  borderRadius: 6,
  background: '#fff',
  color: '#1e293b',
};

const filterSelectStyle: React.CSSProperties = {
  ...inputStyle,
  padding: '5px 8px',
};

const inlineSelectStyle: React.CSSProperties = {
  border: '1px solid transparent',
  borderRadius: 4,
  background: 'transparent',
  fontSize: 12,
  fontFamily: 'inherit',
  color: '#334155',
  cursor: 'pointer',
};

const jumpButtonStyle: React.CSSProperties = {
  marginLeft: 8,
  border: 'none',
  background: 'transparent',
  color: '#94a3b8',
  cursor: 'pointer',
  fontSize: 12,
  padding: 0,
};

function primaryButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: '6px 12px',
    borderRadius: 6,
    border: '1px solid #3b82f6',
    background: disabled ? '#93c5fd' : '#3b82f6',
    color: '#fff',
    fontSize: 12,
    fontWeight: 500,
    fontFamily: 'inherit',
    cursor: disabled ? 'default' : 'pointer',
  };
}

function secondaryButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: '6px 12px',
    borderRadius: 6,
    border: '1px solid #e2e8f0',
    background: disabled ? '#f1f5f9' : '#fff',
    color: disabled ? '#94a3b8' : '#1e293b',
    fontSize: 12,
    fontWeight: 500,
    fontFamily: 'inherit',
    cursor: disabled ? 'default' : 'pointer',
  };
}
