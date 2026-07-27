import { useEffect, useMemo, useState } from 'react';
import {
  compareVersions,
  collectRequirementGhLinks,
  requirementStage,
  stageCounts,
  BUILT_THRESHOLD,
  STAGE_LABEL,
  STAGE_ORDER,
  STAGE_COLOR,
} from '@mindblown/core';
import type { Node, Version, RequirementGate, RequirementStage } from '@mindblown/core';
import { useMindmapStore } from './store.js';
import { linkColor, linkWeight } from './ghLinkStyle.js';
import { REQ_VERSION_NONE } from './urlState.js';
import * as api from './api.js';

// ── Derived requirement stage ────────────────────────────────────
//
// Never stored — derived from the progress rollup folded together with
// the per-gate sign-off verdicts, so the register can't drift from the
// plan (the whole point of the feature). The labels and colours live in
// @mindblown/core because the Word export and the MCP overview have to
// say exactly the same thing.
//
// The word matters: 100 % progress is "Gebaut", not "Done" — the rollup
// only knows that code merged. Green is reserved for the two stages that
// required a human verdict.

/** The register speaks German because its readers are the business side. */
const GATE_LABEL: Record<RequirementGate, string> = { it: 'IT', business: 'Business' };

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
  stage: RequirementStage;
  /** Progress alone says the code landed — kept for "hide done" and Rest. */
  built: boolean;
  /** Active verdicts on this requirement, split by gate. */
  verdicts: Record<RequirementGate, api.AcceptanceRow | undefined>;
  remaining: number;
  unestimated: number;
  health: string;
  ghLinks: Array<{
    id: string;
    url: string;
    inherited: boolean;
    state?: 'open' | 'closed';
    isPullRequest?: boolean;
  }>;
  /** Version set on the requirement node itself. */
  versionId: string | null;
  /** Distinct versions found below it — the requirement may be split across releases. */
  descendantVersionIds: string[];
  /** What the register treats as "the" release: own, else a unanimous descendant one. */
  effectiveVersionId: string | null;
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
  const versionRank = useMemo(() => {
    const m = new Map<string, number>();
    sortedVersions.forEach((v, i) => m.set(v.id, i));
    return m;
  }, [sortedVersions]);

  const user = useMindmapStore((s) => s.user);
  const [acceptances, setAcceptances] = useState<api.AcceptanceRow[]>([]);
  const [acceptanceFilter, setAcceptanceFilter] = useState<'' | api.AcceptanceFilter>('');
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

  const [statusFilter, setStatusFilter] = useState<'' | RequirementStage>('');
  const [priorityFilter, setPriorityFilter] = useState<'' | 'must' | 'should' | 'could'>('');
  // Release filter lives in the store (mirrored to ?rv= / ?rvm= by
  // useUrlState) so the selection survives a copied link.
  const reqVersionFilter = useMindmapStore((s) => s.reqVersionFilter);
  const versionFilterMode = useMindmapStore((s) => s.reqVersionMode);
  const setReqVersionFilter = useMindmapStore((s) => s.setReqVersionFilter);
  const setVersionFilterMode = useMindmapStore((s) => s.setReqVersionMode);
  const showUnscheduledOnly = reqVersionFilter === REQ_VERSION_NONE;
  const [hideDone, setHideDone] = useState(false);
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
        // One active verdict per gate is a DB invariant, so first-wins is
        // exact rather than a heuristic.
        const accs = accByNode.get(node.id) ?? [];
        const verdicts = {
          it: accs.find((a) => a.gate === 'it'),
          business: accs.find((a) => (a.gate ?? 'business') === 'business'),
        };
        return {
          node,
          chapterId: chapter?.id ?? null,
          chapterText: chapter?.text ?? '(root)',
          isLeaf,
          progress,
          stage: requirementStage(progress, accs),
          built: progress >= BUILT_THRESHOLD,
          verdicts,
          remaining: (cv?.computedEffort ?? 0) * (1 - progress / 100),
          unestimated: countUnestimatedLeaves(node.id),
          health: cv?.healthSignal ?? 'on_track',
          ghLinks: collectRequirementGhLinks((id) => nodes[id], node.id).map((l) => ({
            id: l.externalId,
            url: l.url,
            inherited: l.inherited,
            state: l.state,
            isPullRequest: l.isPullRequest,
          })),
          versionId: node.versionId ?? null,
          descendantVersionIds,
          effectiveVersionId:
            node.versionId ??
            (descendantVersionIds.length === 1 ? descendantVersionIds[0] : null),
        };
      });
  }, [nodes, computed, accByNode]);

  const totals = useMemo(() => {
    const counts = stageCounts(allRows.map((r) => r.stage));
    return {
      ...counts,
      built: allRows.filter((r) => r.built).length,
      // The two review queues. Not derivable from the stage counts: a
      // business-accepted requirement can still be missing its IT verdict
      // (every pre-split row was backfilled as business).
      itOpen: allRows.filter((r) => r.built && !r.verdicts.it).length,
      businessOpen: allRows.filter((r) => r.built && !r.verdicts.business).length,
    };
  }, [allRows]);

  // Slider position derived from the selected version id; an id that no
  // longer resolves (deleted version, stale link) falls back to 0 = all.
  const selectedVersionIndex =
    reqVersionFilter && reqVersionFilter !== REQ_VERSION_NONE
      ? (versionRank.get(reqVersionFilter) ?? -1) + 1
      : 0;
  const versionFilterActive = showUnscheduledOnly || selectedVersionIndex > 0;
  const versionLabel = showUnscheduledOnly
    ? 'No release'
    : selectedVersionIndex === 0
      ? 'All releases'
      : `${versionFilterMode === 'exact' ? 'Only' : 'Through'} ${sortedVersions[selectedVersionIndex - 1]?.name ?? ''}`;

  const filteredRows = useMemo(
    () =>
      allRows.filter((r) => {
        // A rejected requirement is never hidden — it is the row that most
        // needs to stay visible, however green the rollup looks.
        if (hideDone && r.built && r.stage !== 'rejected') return false;
        if (statusFilter && r.stage !== statusFilter) return false;
        if (priorityFilter && r.node.requirementPriority !== priorityFilter) return false;
        if (showUnscheduledOnly) {
          // "No release" means nothing below it is scheduled either.
          if (r.versionId || r.descendantVersionIds.length > 0) return false;
        } else if (selectedVersionIndex > 0) {
          const selectedRank = selectedVersionIndex - 1;
          if (versionFilterMode === 'exact') {
            // A split requirement matches every release it touches.
            const selectedId = sortedVersions[selectedRank].id;
            if (r.versionId !== selectedId && !r.descendantVersionIds.includes(selectedId)) {
              return false;
            }
          } else {
            // Cumulative: matches if it (or a split-off descendant) is due
            // by this release or earlier.
            const ownRank = r.versionId ? versionRank.get(r.versionId) : undefined;
            const touchesUpToHere =
              (ownRank != null && ownRank <= selectedRank) ||
              r.descendantVersionIds.some((id) => {
                const rank = versionRank.get(id);
                return rank != null && rank <= selectedRank;
              });
            if (!touchesUpToHere) return false;
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
          // Review queues: only what is far enough along to actually judge.
          if (acceptanceFilter === 'it-open' || acceptanceFilter === 'business-open') {
            if (!r.built) return false;
            const gate: RequirementGate = acceptanceFilter === 'it-open' ? 'it' : 'business';
            if (accs.some((a) => (a.gate ?? 'business') === gate)) return false;
          }
        }
        return true;
      }),
    [
      allRows,
      hideDone,
      statusFilter,
      priorityFilter,
      showUnscheduledOnly,
      selectedVersionIndex,
      versionFilterMode,
      sortedVersions,
      versionRank,
      acceptanceFilter,
      accByNode,
      user,
    ],
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

  const toggleAcceptance = async (row: ReqRow, gate: RequirementGate) => {
    if (!currentMapId || !user) return;
    const mine = (accByNode.get(row.node.id) ?? []).find(
      (a) => a.userId === user.id && (a.gate ?? 'business') === gate,
    );
    try {
      if (mine) {
        await api.revokeAcceptance(currentMapId, row.node.id, gate);
        setAcceptances((prev) => prev.filter((a) => a.id !== mine.id));
      } else {
        // Signing off on something that isn't built yet is legitimate
        // ("good enough, we'll take it") but should never be a slip.
        if (
          !row.built &&
          !window.confirm(
            `${row.node.requirementId} steht auf «${STAGE_LABEL[row.stage]}» — trotzdem ${
              gate === 'it' ? 'als IT-geprüft markieren' : 'abnehmen'
            }?`,
          )
        ) {
          return;
        }
        const created = await api.acceptRequirement(currentMapId, row.node.id, { gate });
        setAcceptances((prev) => [...prev, created]);
      }
    } catch {
      // Refresh on conflict (e.g. accepted elsewhere) — server state wins.
      api.fetchAcceptances(currentMapId).then((r) => setAcceptances(r.acceptances)).catch(() => {});
    }
  };

  const rejectRequirement = async (row: ReqRow, gate: RequirementGate) => {
    if (!currentMapId || !user) return;
    const comment = window.prompt(
      `${row.node.requirementId} zurückweisen (${GATE_LABEL[gate]}) — warum? (Begründung erforderlich)`,
    );
    if (comment == null) return; // cancelled
    if (comment.trim() === '') return;
    try {
      const created = await api.acceptRequirement(currentMapId, row.node.id, {
        decision: 'rejected',
        comment: comment.trim(),
        gate,
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
          {/* The headline number is the ACCEPTED one. Leading with "116
              done" was the whole problem: that count only ever meant code
              had merged, and business read it as delivered. */}
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, marginTop: 3 }}>
            <span style={{ fontSize: 20, fontWeight: 700, color: '#047857', lineHeight: 1 }}>
              {totals.accepted}
            </span>
            <span style={{ fontSize: 11, color: '#64748b' }}>
              von {allRows.length} abgenommen · {totals.built} gebaut, davon{' '}
              {totals.built - totals.accepted} ohne Abnahme
              {(hideDone || statusFilter || priorityFilter || versionFilterActive) &&
                ` · ${filteredRows.length} angezeigt (gefiltert)`}
            </span>
          </div>
          <StageFunnel counts={totals} total={allRows.length} />
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            onClick={() => setHideDone((v) => !v)}
            aria-pressed={hideDone}
            title={
              hideDone
                ? `${totals.built} gebaute Anforderung${totals.built === 1 ? '' : 'en'} ausgeblendet — klicken zum Anzeigen`
                : 'Gebaute Anforderungen ausblenden (100 % Fortschritt; Zurückgewiesene bleiben sichtbar)'
            }
            style={{
              ...secondaryButtonStyle(false),
              ...(hideDone
                ? { background: '#eef2ff', borderColor: '#c7d2fe', color: '#3730a3' }
                : {}),
            }}
          >
            {hideDone ? `Gebaute versteckt (${totals.built})` : 'Gebaute ausblenden'}
          </button>
          <select
            value={statusFilter}
            onChange={(e) => {
              const v = e.target.value as '' | RequirementStage;
              setStatusFilter(v);
              // Asking for a built-or-beyond stage while hiding those would
              // show an empty table.
              if (v === 'built' || v === 'it_verified' || v === 'accepted') setHideDone(false);
            }}
            style={filterSelectStyle}
          >
            <option value="">Alle Stufen</option>
            {STAGE_ORDER.map((s) => (
              <option key={s} value={s}>
                {STAGE_LABEL[s]}
              </option>
            ))}
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
          <div style={versionSliderContainerStyle}>
            <span style={{ fontSize: 11, fontWeight: 600, color: '#64748b' }}>Versions</span>
            {sortedVersions.length > 0 && (
              <>
                <button
                  onClick={() =>
                    setVersionFilterMode(versionFilterMode === 'cumulative' ? 'exact' : 'cumulative')
                  }
                  disabled={showUnscheduledOnly || selectedVersionIndex === 0}
                  title={
                    versionFilterMode === 'cumulative'
                      ? 'Showing everything due by the selected release — click to show only that release'
                      : 'Showing only the selected release — click to include everything due by it'
                  }
                  style={secondaryButtonStyle(showUnscheduledOnly || selectedVersionIndex === 0)}
                >
                  {versionFilterMode === 'cumulative' ? 'Through' : 'Only'}
                </button>
                <input
                  type="range"
                  min={0}
                  max={sortedVersions.length}
                  value={selectedVersionIndex}
                  disabled={showUnscheduledOnly}
                  onChange={(e) => {
                    const i = Number(e.target.value);
                    setReqVersionFilter(i === 0 ? null : (sortedVersions[i - 1]?.id ?? null));
                  }}
                  style={{ width: 110 }}
                  title={versionLabel}
                />
              </>
            )}
            <span
              style={{
                fontSize: 11,
                color: versionFilterActive ? '#3730a3' : '#64748b',
                minWidth: 80,
                whiteSpace: 'nowrap',
              }}
            >
              {versionLabel}
            </span>
            <button
              onClick={() =>
                setReqVersionFilter(showUnscheduledOnly ? null : REQ_VERSION_NONE)
              }
              aria-pressed={showUnscheduledOnly}
              title="Show only requirements with no release assigned (own or inherited)"
              style={{
                ...secondaryButtonStyle(false),
                ...(showUnscheduledOnly
                  ? { background: '#eef2ff', borderColor: '#c7d2fe', color: '#3730a3' }
                  : {}),
              }}
            >
              No release
            </button>
          </div>
          <select
            value={acceptanceFilter}
            onChange={(e) => setAcceptanceFilter(e.target.value as '' | api.AcceptanceFilter)}
            style={filterSelectStyle}
          >
            <option value="">Abnahme: alle</option>
            <option value="it-open">IT-Prüfung offen ({totals.itOpen})</option>
            <option value="business-open">Abnahme offen ({totals.businessOpen})</option>
            <option value="none">Ohne Urteil</option>
            <option value="mine-open">Mein Urteil ausstehend</option>
            <option value="rejected">Zurückgewiesen</option>
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
                // The active filter bar travels along: you export what you see.
                const blob = await api.exportRequirementsDocx(currentMapId, {
                  status: statusFilter || undefined,
                  priority: priorityFilter || undefined,
                  release: reqVersionFilter ?? undefined,
                  releaseMode: versionFilterMode === 'exact' ? 'exact' : undefined,
                  hideDone: hideDone || undefined,
                  acceptance: acceptanceFilter || undefined,
                });
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
            title="Als Anforderungsdokument (Word) exportieren — aktive Filter werden übernommen"
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
            {/* Fixed layout + colgroup: without it the browser sizes columns
                from their widest cell, so changing the release filter (which
                changes which selects/chips/links are on screen) reshuffles
                every column width. */}
            <colgroup>
              <col style={{ width: 100 }} />
              <col /> {/* Requirement — absorbs the remaining width */}
              <col style={{ width: 90 }} />
              <col style={{ width: 120 }} />
              <col style={{ width: 90 }} />
              <col style={{ width: 140 }} />
              <col style={{ width: 120 }} />
              <col style={{ width: 145 }} />
              <col style={{ width: 180 }} />
            </colgroup>
            <thead>
              <tr>
                <th style={thStyle}>ID</th>
                <th style={thStyle}>Requirement</th>
                <th style={thStyle}>Priority</th>
                <th style={thStyle}>Release</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>Progress</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Remaining</th>
                <th style={thStyle}>GitHub</th>
                <th style={thStyle}>Acceptance</th>
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
  currentUserId: string | null;
  toggleAcceptance: (row: ReqRow, gate: RequirementGate) => void;
  rejectRequirement: (row: ReqRow, gate: RequirementGate) => void;
}) {
  const built = rows.filter((r) => r.built).length;
  const accepted = rows.filter((r) => r.stage === 'accepted').length;
  return (
    <>
      <tr>
        <td colSpan={9} style={groupHeaderStyle}>
          {chapterText}
          <span style={{ fontWeight: 400, color: '#64748b', marginLeft: 8 }}>
            {rows.length} req · {built} gebaut · {accepted} abgenommen
          </span>
        </td>
      </tr>
      {rows.map((r, i) => (
        <tr
          key={r.node.id}
          onClick={() => jumpToNode(r.node)}
          onMouseEnter={(e) => (e.currentTarget.style.background = '#eff6ff')}
          onMouseLeave={(e) => (e.currentTarget.style.background = stripeFor(i))}
          title="Open in mindmap"
          style={{
            background: stripeFor(i),
            borderBottom: '1px solid #f1f5f9',
            cursor: 'pointer',
          }}
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
              <span style={{ cursor: 'text', display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <span
                  style={{
                    flexShrink: 0,
                    width: 7,
                    height: 7,
                    marginTop: 5,
                    borderRadius: '50%',
                    background: HEALTH_COLOR[r.health] ?? '#94a3b8',
                  }}
                  title={`Health: ${r.health}`}
                />
                {/* Requirement statements are sentences — wrap to two lines
                    rather than truncating mid-clause. */}
                <span
                  style={{
                    // Shrink-to-fit, not grow — keeps ↗ next to the title
                    // instead of stranding it at the far edge of a wide column.
                    flex: '0 1 auto',
                    minWidth: 0,
                    display: '-webkit-box',
                    WebkitBoxOrient: 'vertical',
                    WebkitLineClamp: 2,
                    overflow: 'hidden',
                    lineHeight: 1.4,
                  }}
                  title={
                    r.node.requirementText != null && r.node.requirementText !== r.node.text
                      ? `Node: ${r.node.text}`
                      : (r.node.requirementText ?? r.node.text)
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
                // A select is as wide as its widest <option>, and the
                // placeholder differs per row ("—" / "↳ V2" / "↳ 3 releases").
                // Pinning it to the column stops that leaking into layout.
                width: '100%',
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

          {/* Derived stage — read-only by design */}
          <td style={tdStyle}>
            <span
              title={
                r.built
                  ? 'Abgeleitet aus Fortschritt + Abnahme-Urteilen. «Gebaut» heisst: Code fertig, noch niemand hat unterschrieben.'
                  : 'Abgeleitet aus dem Fortschritts-Rollup — die darunterliegende Arbeit abschliessen, um das zu ändern'
              }
              style={{
                padding: '2px 8px',
                borderRadius: 10,
                fontSize: 11,
                fontWeight: 600,
                whiteSpace: 'nowrap',
                background: STAGE_COLOR[r.stage].bg,
                color: STAGE_COLOR[r.stage].fg,
              }}
            >
              {STAGE_LABEL[r.stage]}
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
          <td style={{ ...tdStyle, ...numericCellStyle }}>
            {r.built ? (
              <span style={{ color: '#94a3b8' }}>—</span>
            ) : (
              `${r.remaining.toFixed(1)} ${effortUnit}`
            )}
            {!r.built && r.unestimated > 0 && (
              <span
                title={`${r.unestimated} unestimated leaf/leaves under this requirement — remaining under-counts`}
                style={{ color: '#d97706', marginLeft: 6, cursor: 'help' }}
              >
                ⚠{r.unestimated}
              </span>
            )}
          </td>

          {/* GitHub links — capped so a heavily-linked requirement can't widen
              the column relative to a sparse one */}
          <td style={{ ...tdStyle, ...clippedCellStyle }}>
            {r.ghLinks.length === 0 ? (
              <span style={{ color: '#cbd5e1' }}>—</span>
            ) : (
              r.ghLinks.slice(0, GH_LINK_CAP).map((l, i) => {
                // GitHub shares one number space between issues and PRs, so
                // a link can point at either. Say which — a merged PR
                // reported as a closed "issue" reads as done work that was
                // never tracked.
                const kind = l.isPullRequest ? 'Pull request' : 'Issue';
                const titleParts = [
                  // Always say so, even when nothing else applies — an
                  // open PR link would otherwise carry no tooltip at all.
                  l.isPullRequest ? 'Links a pull request, not an issue' : null,
                  l.inherited
                    ? `${kind} on work below this requirement, not on the requirement itself`
                    : null,
                  l.state === 'closed' ? `${kind} is closed` : null,
                ].filter(Boolean);
                return (
                  <a
                    key={l.id}
                    href={l.url}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    title={titleParts.length > 0 ? titleParts.join(' — ') : undefined}
                    style={{
                      // Two signals, one channel. Colour family = issue
                      // state, shade within it = own vs inherited.
                      //
                      // Opacity used to carry "closed", back when the
                      // `state` field was almost never written and so
                      // nothing actually dimmed. Once it was populated
                      // ~90% of links turned out to be closed, which made
                      // dimming the default and stacked it with the pale
                      // inherited blue into a near-invisible tier. Marking
                      // the majority is backwards — open is the exception
                      // worth the eye, so it gets the colour and weight.
                      color: linkColor(l.state, l.inherited),
                      fontWeight: linkWeight(l.state),
                      textDecoration: 'none',
                      marginLeft: i > 0 ? 6 : 0,
                    }}
                  >
                    {l.id.includes('#') ? `#${l.id.split('#')[1]}` : l.id}
                  </a>
                );
              })
            )}
            {r.ghLinks.length > GH_LINK_CAP && (
              <span
                title={r.ghLinks
                  .slice(GH_LINK_CAP)
                  .map((l) => (l.id.includes('#') ? `#${l.id.split('#')[1]}` : l.id))
                  .join(', ')}
                style={{ color: '#94a3b8', marginLeft: 6, cursor: 'help' }}
              >
                +{r.ghLinks.length - GH_LINK_CAP}
              </span>
            )}
          </td>

          {/* Abnahme — one slot per gate. Two ✓ from the same person would
              be indistinguishable without the gate label above them. */}
          <td style={{ ...tdStyle, ...wrappingCellStyle }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', gap: 10 }}>
              {(['it', 'business'] as const).map((gate) => (
                <GateSlot
                  key={gate}
                  gate={gate}
                  row={r}
                  currentUserId={currentUserId}
                  onToggle={toggleAcceptance}
                  onReject={rejectRequirement}
                />
              ))}
            </div>
          </td>
        </tr>
      ))}
    </>
  );
}

// ── Small pieces ─────────────────────────────────────────────────

/**
 * One gate's verdict slot. Either the standing verdict (own chip clicks
 * to withdraw) or the ✓/✗ pair to record one.
 */
function GateSlot({
  gate,
  row,
  currentUserId,
  onToggle,
  onReject,
}: {
  gate: RequirementGate;
  row: ReqRow;
  currentUserId: string | null;
  onToggle: (row: ReqRow, gate: RequirementGate) => void;
  onReject: (row: ReqRow, gate: RequirementGate) => void;
}) {
  const a = row.verdicts[gate];
  const own = a != null && a.userId === currentUserId;
  const stale =
    a != null &&
    (Math.abs(row.progress - a.progressAtAcceptance) > 1 ||
      row.node.revision !== a.nodeRevisionAtAcceptance);
  const rejected = a?.decision === 'rejected';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 70 }}>
      <span
        style={{
          fontSize: 9,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: '#94a3b8',
          fontWeight: 700,
        }}
      >
        {GATE_LABEL[gate]}
      </span>
      {a ? (
        <span
          onClick={own ? () => onToggle(row, gate) : undefined}
          title={
            (stale ? 'Seit dem Urteil geändert! ' : '') +
            `${a.userName}, ${rejected ? 'zurückgewiesen' : 'erteilt'} ${a.acceptedAt.slice(0, 10)} bei ${Math.round(a.progressAtAcceptance)} %` +
            (rejected && a.comment ? ` — «${a.comment}»` : '') +
            (own ? ' — klicken zum Zurückziehen' : '')
          }
          style={{
            display: 'inline-block',
            padding: '2px 8px',
            borderRadius: 10,
            fontSize: 11,
            fontWeight: 600,
            whiteSpace: 'nowrap',
            cursor: own ? 'pointer' : 'default',
            background: rejected ? '#fee2e2' : stale ? '#fef3c7' : '#d1fae5',
            color: rejected ? '#991b1b' : stale ? '#92400e' : '#065f46',
          }}
        >
          {stale ? '⚠ ' : ''}
          {a.userName.split(' ')[0]} {rejected ? '✗' : '✓'}{' '}
          {a.acceptedAt.slice(5, 10).split('-').reverse().join('.')}.
        </span>
      ) : currentUserId ? (
        <span style={{ display: 'flex', gap: 3 }}>
          <button
            onClick={() => onToggle(row, gate)}
            title={
              gate === 'it'
                ? 'IT-Prüfung erteilen — funktioniert wie gebaut'
                : 'Abnehmen — ist das, was bestellt wurde'
            }
            style={ghostChipStyle('#cbd5e1', '#64748b')}
          >
            ✓
          </button>
          <button
            onClick={() => onReject(row, gate)}
            title="Zurückweisen — Begründung erforderlich"
            style={ghostChipStyle('#fca5a5', '#b91c1c')}
          >
            ✗
          </button>
        </span>
      ) : (
        <span style={{ color: '#cbd5e1', fontSize: 11 }}>—</span>
      )}
    </div>
  );
}

function ghostChipStyle(borderColor: string, color: string): React.CSSProperties {
  return {
    padding: '2px 7px',
    borderRadius: 10,
    fontSize: 11,
    border: `1px dashed ${borderColor}`,
    background: 'transparent',
    color,
    cursor: 'pointer',
  };
}

/**
 * The funnel bar under the header. Its job is to make the gap between
 * "gebaut" and "abgenommen" impossible to skip past — a single green
 * percentage never showed it.
 */
function StageFunnel({
  counts,
  total,
}: {
  counts: Record<RequirementStage, number>;
  total: number;
}) {
  if (total === 0) return null;
  const segments = STAGE_ORDER.filter((s) => counts[s] > 0);
  return (
    <div style={{ marginTop: 6, maxWidth: 460 }}>
      <div
        style={{
          display: 'flex',
          height: 8,
          borderRadius: 4,
          overflow: 'hidden',
          background: '#f1f5f9',
        }}
      >
        {segments.map((s) => (
          <div
            key={s}
            title={`${counts[s]} ${STAGE_LABEL[s]}`}
            style={{ width: `${(counts[s] / total) * 100}%`, background: STAGE_COLOR[s].fg }}
          />
        ))}
      </div>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '2px 12px',
          marginTop: 5,
          fontSize: 10,
          color: '#64748b',
        }}
      >
        {STAGE_ORDER.filter((s) => counts[s] > 0 || s === 'accepted').map((s) => (
          <span key={s} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <i
              style={{
                width: 7,
                height: 7,
                borderRadius: 2,
                background: STAGE_COLOR[s].fg,
                display: 'inline-block',
              }}
            />
            {STAGE_LABEL[s]} <b style={{ color: '#334155' }}>{counts[s]}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

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
      <span
        style={{
          fontSize: 11,
          color: '#64748b',
          minWidth: 32,
          textAlign: 'right',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
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
  // Fixed columns total 985px; below this the requirement title would be
  // crushed, so the wrapper scrolls horizontally instead.
  minWidth: 1280,
  tableLayout: 'fixed',
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
  // Above the (also sticky) chapter header rows.
  zIndex: 2,
};

/** Height of the sticky <thead> row — chapter headers park directly below it. */
const HEAD_HEIGHT = 33;

const tdStyle: React.CSSProperties = {
  padding: '8px 16px',
  fontSize: 12,
  color: '#334155',
  verticalAlign: 'middle',
};

/** Under table-layout: fixed, nowrap content spills unless the cell clips. */
const clippedCellStyle: React.CSSProperties = {
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

/**
 * Two sign-offs don't fit on one line at this column width, and dropping the
 * second to an ellipsis loses who signed. The column width is fixed either
 * way, so wrapping costs nothing but row height.
 */
const wrappingCellStyle: React.CSSProperties = {
  whiteSpace: 'normal',
  overflow: 'hidden',
};

const numericCellStyle: React.CSSProperties = {
  ...clippedCellStyle,
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
};

/** Issue links shown before collapsing the rest into a "+N" hint. */
const GH_LINK_CAP = 2;


const groupHeaderStyle: React.CSSProperties = {
  padding: '10px 16px',
  fontSize: 12,
  fontWeight: 600,
  color: '#3730a3',
  background: '#eef2ff',
  borderBottom: '1px solid #e0e7ff',
  // Keeps the chapter visible while scrolling a long register. Sticky goes on
  // the <td>, not the <tr> — Chrome/Safari ignore it on table rows.
  position: 'sticky',
  top: HEAD_HEIGHT,
  zIndex: 1,
};

/** Alternating row background — striping survives hover via onMouseLeave. */
const stripeFor = (i: number) => (i % 2 === 1 ? '#fbfcfe' : '#ffffff');

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

const versionSliderContainerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '4px 8px',
  border: '1px solid #e2e8f0',
  borderRadius: 6,
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
  flexShrink: 0,
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
