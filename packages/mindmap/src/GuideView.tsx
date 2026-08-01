import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Node } from '@mindblown/core';
import { useMindmapStore } from './store.js';
import {
  buildGuideEntries,
  filterGuideChapters,
  groupGuideEntries,
  guideMarker,
  initialExpandedChapters,
  type GuideChapter,
  type GuideEntry,
} from './guide.js';

/**
 * The Anwenderansicht — "So prüfst du das".
 *
 * A reading surface for the person who has to *check* a criterion, next to
 * (never inside) the requirements register. The register is a controlling
 * instrument: nine columns, six filters, one row per requirement. Five of
 * those nine columns are noise to a reader whose only question is "how do I
 * verify this myself?", and the Prüfanleitung briefly squeezed into its
 * Abnahme cell was unreadable at that width. So this view drops everything
 * the question doesn't need:
 *
 * - **Left: three facts.** Kürzel, title, one marker. Nothing else.
 * - **Right: the criterion whole.** Steps at full reading width, the clip
 *   as a real player, two actions.
 *
 * It deliberately does NOT load acceptances. Signing off is the register's
 * job; conflating "I understand how to check this" with "I hereby accept
 * it" is exactly the confusion the two-gate model was built to prevent.
 *
 * Same store as RequirementsView.tsx and the same derivation rules (chapter
 * = parent node, REQ-ID order), but a separate surface. The two are linked
 * in both directions through `selectedNodeId` alone: the register's marker
 * sets it and switches here, "Im Register ansehen" does the reverse. No
 * shared state beyond the selection the URL already carries.
 */

// ── Palette ──────────────────────────────────────────────────────
//
// MindBlown has no theme layer: no CSS custom properties, no Tailwind, no
// `prefers-color-scheme` anywhere in the app. Every view carries its own
// `React.CSSProperties` constants over the same slate + indigo palette,
// so that is what this view does too — naming the tones it uses rather
// than standing up a second, competing token system for one screen.

const PAPER = '#f8fafc';
const RAISED = '#ffffff';
const INK = '#1e293b';
const INK_SOFT = '#334155';
const MUTED = '#64748b';
const FAINT = '#94a3b8';
const HAIRLINE = '#e2e8f0';
const ACCENT = '#4f46e5';
const ACCENT_INK = '#3730a3';
const ACCENT_SOFT = '#eef2ff';
const ACCENT_LINE = '#c7d2fe';

const MONO = 'Menlo, Monaco, Consolas, monospace';

// ── Component ────────────────────────────────────────────────────

export function GuideView() {
  const nodes = useMindmapStore((s) => s.nodes);
  const computed = useMindmapStore((s) => s.computed);
  const rootNodeId = useMindmapStore((s) => s.rootNodeId);
  const selectedNodeId = useMindmapStore((s) => s.selectedNodeId);
  const selectNode = useMindmapStore((s) => s.selectNode);
  const setFocusNode = useMindmapStore((s) => s.setFocusNode);
  const setActiveView = useMindmapStore((s) => s.setActiveView);

  const [query, setQuery] = useState('');

  const entries = useMemo(
    () =>
      buildGuideEntries(nodes, (node) =>
        node.childrenIds.length === 0
          ? (node.percentComplete ?? 0)
          : (computed.get(node.id)?.computedProgress ?? 0),
      ),
    [nodes, computed],
  );

  // Depth-first index of the tree, so chapters read in map order — the
  // same ordering rule the register uses.
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

  const chapters = useMemo(
    () => groupGuideEntries(entries, (id) => dfsOrder.get(id) ?? Infinity),
    [entries, dfsOrder],
  );

  const visibleChapters = useMemo(
    () => filterGuideChapters(chapters, query),
    [chapters, query],
  );

  // The selection lives in the store's `selectedNodeId`, which useUrlState
  // already mirrors to `?node=`. That makes a link to one criterion
  // shareable for free, and it survives a reload — no second parameter, no
  // second source of truth. A selection pointing at a non-requirement node
  // (picked in the mindmap) simply resolves to nothing here.
  const selected = useMemo(
    () => entries.find((e) => e.node.id === selectedNodeId) ?? null,
    [entries, selectedNodeId],
  );

  // Folding state: derived from the map's size until the reader touches it,
  // then his. Deriving rather than seeding via an effect means arriving on a
  // deep link opens the right chapter on the first paint, with no flash of
  // a wrongly-folded rail.
  const [expandedOverride, setExpandedOverride] = useState<Set<string> | null>(null);
  const derivedExpanded = useMemo(
    () => initialExpandedChapters(chapters, selected?.chapterId ?? null),
    [chapters, selected?.chapterId],
  );
  const expanded = expandedOverride ?? derivedExpanded;
  // While searching every surviving chapter is open: a hit hidden inside a
  // folded chapter looks exactly like no hit at all.
  const searching = query.trim() !== '';
  const isExpanded = (id: string) => searching || expanded.has(id);
  const toggleChapter = (id: string) =>
    setExpandedOverride(() => {
      const next = new Set(expanded);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  // A rail holding 168 rows scrolls far past one screen, so a criterion
  // reached by link has to be brought into view — otherwise a shared link
  // lands on a rail that looks like it selected nothing.
  const selectedRef = useRef<HTMLButtonElement | null>(null);
  const detailRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' });
    detailRef.current?.scrollTo({ top: 0 });
  }, [selectedNodeId]);

  /**
   * Editing is a jump into the existing property panel, not a second
   * editor: the three Prüf-felder already have one home, and a copy here
   * would be a second place for the same value to drift. Same move the
   * register makes when you click a row.
   */
  const editGuide = (node: Node) => {
    setActiveView('mindmap');
    selectNode(node.id);
    setFocusNode(node.parentId && node.parentId !== rootNodeId ? node.parentId : null);
    (window as unknown as { __mindmapPanToNode?: (id: string) => void }).__mindmapPanToNode?.(
      node.id,
    );
  };

  /**
   * Back to the register, on this criterion — the return leg of the marker
   * that got the reader here. "How do I check this?" and "where does this
   * stand?" are two questions about the same row, and answering the second
   * should not cost a scroll through 168 of them: the register reads the
   * same `selectedNodeId` and scrolls the row into view.
   */
  const showInRegister = (node: Node) => {
    setActiveView('requirements');
    selectNode(node.id);
  };

  if (!rootNodeId) {
    return (
      <div style={containerStyle}>
        <Placeholder title="Keine Karte geöffnet" body="Öffne eine Karte, um ihre Kriterien zu sehen." />
      </div>
    );
  }

  const withGuide = entries.filter((e) => e.guideText != null).length;
  const withVideo = entries.filter((e) => e.videoUrl != null).length;

  return (
    <div style={containerStyle}>
      <style>{guideCss}</style>

      <div style={headerStyle}>
        <h2 style={{ margin: 0, fontSize: 16, color: INK }}>Prüfanleitungen</h2>
        <div style={{ fontSize: 11, color: MUTED, marginTop: 3 }}>
          {entries.length} Kriterien · {withGuide} mit Prüfanleitung · {withVideo} mit Video
        </div>
      </div>

      {entries.length === 0 ? (
        <Placeholder
          title="Noch keine Kriterien"
          body="Diese Ansicht zeigt jeden Knoten mit einer Requirement-ID. Vergib eine im Eigenschaften-Panel, dann steht er hier."
        />
      ) : (
        <div className="mb-guide-grid">
          {/* ── Left rail ─────────────────────────────────────── */}
          <aside className="mb-guide-rail">
            <div style={searchWrapStyle}>
              <input
                className="mb-guide-search"
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
                placeholder="Kriterium oder Kürzel suchen…"
                aria-label="Kriterium suchen"
                style={searchStyle}
              />
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: '0 10px 24px' }}>
              {visibleChapters.length === 0 ? (
                <div style={{ padding: '18px 6px', fontSize: 12.5, color: MUTED }}>
                  Nichts gefunden für „{query.trim()}“.
                </div>
              ) : (
                visibleChapters.map((chapter) => (
                  <ChapterBlock
                    key={chapter.id}
                    chapter={chapter}
                    open={isExpanded(chapter.id)}
                    onToggle={() => toggleChapter(chapter.id)}
                    selectedNodeId={selectedNodeId}
                    selectedRef={selectedRef}
                    onSelect={(entry) => selectNode(entry.node.id)}
                  />
                ))
              )}
            </div>
          </aside>

          {/* ── Detail ────────────────────────────────────────── */}
          <main className="mb-guide-detail" ref={detailRef}>
            {selected ? (
              <GuideCard
                entry={selected}
                onEdit={() => editGuide(selected.node)}
                onShowInRegister={() => showInRegister(selected.node)}
              />
            ) : (
              <Placeholder
                title="Wähle links ein Kriterium"
                body={
                  chapters.length > 1
                    ? `${chapters.length} Kapitel, ${entries.length} Kriterien. Zu jedem steht hier, wie du es selbst nachprüfst — Schritte und, wo vorhanden, ein kurzer Clip.`
                    : 'Zu jedem Kriterium steht hier, wie du es selbst nachprüfst.'
                }
              />
            )}
          </main>
        </div>
      )}
    </div>
  );
}

// ── Left rail ────────────────────────────────────────────────────

function ChapterBlock({
  chapter,
  open,
  onToggle,
  selectedNodeId,
  selectedRef,
  onSelect,
}: {
  chapter: GuideChapter;
  open: boolean;
  onToggle: () => void;
  selectedNodeId: string | null;
  selectedRef: React.MutableRefObject<HTMLButtonElement | null>;
  onSelect: (entry: GuideEntry) => void;
}) {
  return (
    <div style={{ marginBottom: 2 }}>
      {/* Sticky inside the rail's own scroller: working down a chapter of
          twelve, the heading you are under is the one fact worth keeping
          on screen. */}
      <button
        className="mb-guide-chapter"
        onClick={onToggle}
        aria-expanded={open}
        style={chapterStyle}
      >
        <span style={{ color: FAINT, fontSize: 9, width: 9 }}>{open ? '▼' : '▶'}</span>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {chapter.text}
        </span>
        <span style={{ color: FAINT, fontWeight: 400 }}>{chapter.entries.length}</span>
      </button>
      {open &&
        chapter.entries.map((entry) => {
          const current = entry.node.id === selectedNodeId;
          const marker = guideMarker(entry);
          return (
            <button
              key={entry.node.id}
              ref={current ? selectedRef : undefined}
              className="mb-guide-item"
              onClick={() => onSelect(entry)}
              aria-current={current}
              title={entry.available ? entry.title : `${entry.title} — noch nicht verfügbar`}
              style={{
                ...itemStyle,
                background: current ? ACCENT_SOFT : 'transparent',
                boxShadow: current ? `inset 3px 0 0 ${ACCENT}` : 'none',
              }}
            >
              <span
                style={{
                  fontFamily: MONO,
                  fontSize: 10.5,
                  color: current ? ACCENT_INK : entry.available ? MUTED : FAINT,
                }}
              >
                {entry.requirementId}
              </span>
              <span
                style={{
                  fontSize: 12.5,
                  lineHeight: 1.35,
                  color: entry.available ? INK_SOFT : FAINT,
                  display: '-webkit-box',
                  WebkitBoxOrient: 'vertical',
                  WebkitLineClamp: 2,
                  overflow: 'hidden',
                }}
              >
                {entry.title}
              </span>
              <Marker marker={marker} />
            </button>
          );
        })}
    </div>
  );
}

/**
 * One dot per row. Filled = a written Anleitung exists; filled with a
 * triangle = a clip too; a hollow ring = nothing written yet. The ring is
 * deliberately quiet — a missing Anleitung is a gap in the documentation,
 * not a fault in the product.
 */
function Marker({ marker }: { marker: ReturnType<typeof guideMarker> }) {
  const label =
    marker === 'video'
      ? 'Prüfanleitung und Video vorhanden'
      : marker === 'guide'
        ? 'Prüfanleitung vorhanden'
        : 'Noch keine Prüfanleitung';
  if (marker === 'video') {
    return (
      <span title={label} aria-label={label} style={{ fontSize: 9, color: ACCENT, lineHeight: 1 }}>
        ▶
      </span>
    );
  }
  return (
    <span
      title={label}
      aria-label={label}
      style={{
        width: 7,
        height: 7,
        borderRadius: '50%',
        background: marker === 'guide' ? ACCENT : 'transparent',
        border: marker === 'guide' ? 'none' : `1px solid ${HAIRLINE}`,
      }}
    />
  );
}

// ── Detail card ──────────────────────────────────────────────────

function GuideCard({
  entry,
  onEdit,
  onShowInRegister,
}: {
  entry: GuideEntry;
  onEdit: () => void;
  onShowInRegister: () => void;
}) {
  return (
    <div style={cardStyle}>
      <div style={eyebrowStyle}>
        <span style={{ color: ACCENT }}>{entry.requirementId}</span>
        <span>{entry.chapterText}</span>
      </div>
      <h3 style={titleStyle}>{entry.title}</h3>
      {entry.lede && <p style={ledeStyle}>{entry.lede}</p>}

      {/* Not built yet: said plainly and once, in grey. That something does
          not exist yet is a state of the plan, not an error — red here
          would read as "broken". The Anleitung, if someone wrote one ahead
          of time, still follows below rather than being swallowed. */}
      {!entry.available && (
        <div style={noticeStyle}>
          <span style={noticeDotStyle} />
          <div>
            <b style={{ fontWeight: 600, color: INK_SOFT }}>
              Diese Funktion ist noch nicht verfügbar.
            </b>
            <br />
            {entry.guideText != null
              ? 'Die Anleitung unten ist bereits geschrieben — prüfbar wird sie, sobald die Funktion ausgeliefert ist.'
              : 'Sobald sie da ist, steht hier, wie du sie prüfst.'}
          </div>
        </div>
      )}

      {/* The clip gets a real player, or the block is left out entirely.
          Today `verificationVideoUrl` is empty on every requirement, so no
          video is the normal case — an empty 16:9 frame on every criterion
          would be the loudest element of a view built to be quiet. */}
      {entry.videoUrl && (
        <div style={{ marginBottom: 24 }}>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video
            src={entry.videoUrl}
            controls
            preload="metadata"
            style={{
              width: '100%',
              // Capped rather than card-wide: at full width a 16:9 clip is
              // ~500px tall and pushes every step below the fold, which
              // turns a page about *following instructions* into a video
              // player. Fullscreen is one click away when the detail
              // matters.
              maxWidth: 640,
              display: 'block',
              borderRadius: 10,
              border: `1px solid ${HAIRLINE}`,
              background: '#0f172a',
            }}
          />
        </div>
      )}

      {entry.guideText != null ? (
        <>
          <div style={sectionLabelStyle}>Schritte</div>
          <div className="mb-guide-md" style={stepsStyle}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={guideMarkdownComponents}>
              {entry.guideText}
            </ReactMarkdown>
          </div>
        </>
      ) : (
        entry.available && (
          <div style={noticeStyle}>
            <span style={noticeDotStyle} />
            <div>
              <b style={{ fontWeight: 600, color: INK_SOFT }}>
                Für dieses Kriterium ist noch keine Prüfanleitung hinterlegt.
              </b>
              <br />
              Über „Anleitung bearbeiten“ kannst du sie schreiben.
            </div>
          </div>
        )
      )}

      {/* Whatever someone hung on the criterion — a spec, an export, a
          screenshot, a link to a ticket. Rendered after the steps rather
          than before: a reader is here to follow instructions, and the
          material is what they reach for when a step doesn't match. The
          block disappears entirely when there is nothing, same rule as
          the video. */}
      {(entry.node.attachments ?? []).length > 0 && (
        <div style={{ marginTop: 20 }}>
          <div style={sectionLabelStyle}>Material</div>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
            {(entry.node.attachments ?? []).map((a) => (
              <li key={a.id}>
                <a
                  className="mb-guide-btn"
                  href={a.url}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    ...quietBtnStyle,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    textDecoration: 'none',
                    maxWidth: '100%',
                  }}
                >
                  <span aria-hidden>{a.kind === 'file' ? '📎' : '🔗'}</span>
                  <span
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {a.title}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div style={actionsStyle}>
        {/* No URL, no button — a dead link that looks live is worse than an
            absent one, and `verificationUrl` is unvalidated free text. */}
        {entry.appUrl && (
          <a
            className="mb-guide-btn"
            href={entry.appUrl}
            target="_blank"
            rel="noreferrer"
            style={primaryBtnStyle}
          >
            In der Anwendung öffnen ↗
          </a>
        )}
        <button
          className="mb-guide-btn"
          onClick={onEdit}
          title="Öffnet das Kriterium in der Mindmap; die Prüf-Felder stehen im Eigenschaften-Panel"
          style={quietBtnStyle}
        >
          Anleitung bearbeiten
        </button>
        <button
          className="mb-guide-btn"
          onClick={onShowInRegister}
          title="Zeigt dieses Kriterium im Anforderungsregister — Status, Release, Abnahme"
          style={quietBtnStyle}
        >
          Im Register ansehen
        </button>
      </div>
    </div>
  );
}

/**
 * Links inside the Anleitung open in a new tab: react-markdown emits a bare
 * `<a href>`, and GFM autolinks turn a naked URL typed into an Anleitung
 * into one whether the author meant it or not. Navigating the app away
 * mid-check loses the reader's place.
 *
 * No isHttpUrl() guard: react-markdown's defaultUrlTransform already
 * empties `javascript:` and `data:` hrefs. The two buttons above need the
 * guard because nothing sanitises those.
 */
const guideMarkdownComponents: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
};

function Placeholder({ title, body }: { title: string; body: string }) {
  return (
    <div style={placeholderStyle}>
      <div style={{ fontSize: 14, fontWeight: 600, color: INK, marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 13, maxWidth: 44 * 8, lineHeight: 1.6 }}>{body}</div>
    </div>
  );
}

// ── Styles ───────────────────────────────────────────────────────

const containerStyle: React.CSSProperties = {
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  background: PAPER,
  fontFamily: 'inherit',
  overflow: 'hidden',
};

const headerStyle: React.CSSProperties = {
  padding: '14px 24px',
  borderBottom: `1px solid ${HAIRLINE}`,
  background: RAISED,
  flexShrink: 0,
};

const searchWrapStyle: React.CSSProperties = {
  padding: '14px 14px 10px',
  flexShrink: 0,
};

const searchStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '7px 11px',
  fontSize: 13,
  fontFamily: 'inherit',
  color: INK,
  background: RAISED,
  border: `1px solid ${HAIRLINE}`,
  borderRadius: 8,
  outline: 'none',
};

const chapterStyle: React.CSSProperties = {
  position: 'sticky',
  top: 0,
  zIndex: 1,
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  width: '100%',
  textAlign: 'left',
  padding: '7px 8px',
  marginTop: 8,
  border: 'none',
  borderRadius: 6,
  background: PAPER,
  color: MUTED,
  fontFamily: MONO,
  fontSize: 10.5,
  fontWeight: 600,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  cursor: 'pointer',
};

const itemStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'auto 1fr auto',
  alignItems: 'center',
  gap: 9,
  width: '100%',
  textAlign: 'left',
  padding: '7px 9px',
  border: 'none',
  borderRadius: 6,
  fontFamily: 'inherit',
  cursor: 'pointer',
};

const cardStyle: React.CSSProperties = {
  // A reading surface, not a dashboard panel: on a wide monitor the card
  // stops rather than stretching, so the steps keep a book's measure
  // instead of running the full width of a 27-inch screen.
  maxWidth: 880,
  width: '100%',
  background: RAISED,
  border: `1px solid ${HAIRLINE}`,
  borderRadius: 12,
  boxShadow: '0 1px 2px rgba(15,23,42,.04), 0 8px 24px -16px rgba(15,23,42,.18)',
  padding: '24px 28px 26px',
};

const eyebrowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 9,
  fontFamily: MONO,
  fontSize: 10,
  letterSpacing: '0.09em',
  textTransform: 'uppercase',
  color: MUTED,
  marginBottom: 8,
};

const titleStyle: React.CSSProperties = {
  margin: '0 0 9px',
  fontSize: 20,
  fontWeight: 600,
  lineHeight: 1.3,
  color: INK,
  maxWidth: '34em',
};

const ledeStyle: React.CSSProperties = {
  margin: '0 0 20px',
  fontSize: 13.5,
  lineHeight: 1.6,
  color: MUTED,
  maxWidth: '58ch',
};

const sectionLabelStyle: React.CSSProperties = {
  fontFamily: MONO,
  fontSize: 10,
  letterSpacing: '0.09em',
  textTransform: 'uppercase',
  color: MUTED,
  marginBottom: 12,
};

const stepsStyle: React.CSSProperties = {
  fontSize: 13.5,
  lineHeight: 1.65,
  color: INK_SOFT,
  // Prose, not a data grid: past ~70 characters the eye loses the line it
  // came from on the way back.
  maxWidth: '68ch',
  marginBottom: 24,
};

const noticeStyle: React.CSSProperties = {
  display: 'flex',
  gap: 11,
  alignItems: 'flex-start',
  padding: '14px 16px',
  marginBottom: 22,
  border: `1px dashed ${HAIRLINE}`,
  borderRadius: 10,
  fontSize: 13,
  lineHeight: 1.6,
  color: MUTED,
  maxWidth: '62ch',
};

const noticeDotStyle: React.CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: '50%',
  background: FAINT,
  marginTop: 7,
  flexShrink: 0,
};

const actionsStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 10,
  alignItems: 'center',
  paddingTop: 18,
  borderTop: `1px solid ${HAIRLINE}`,
};

const primaryBtnStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '8px 14px',
  borderRadius: 8,
  border: `1px solid ${ACCENT}`,
  background: ACCENT,
  color: '#ffffff',
  fontSize: 13,
  fontWeight: 500,
  fontFamily: 'inherit',
  textDecoration: 'none',
  cursor: 'pointer',
};

const quietBtnStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '8px 14px',
  borderRadius: 8,
  border: `1px solid ${HAIRLINE}`,
  background: 'transparent',
  color: MUTED,
  fontSize: 13,
  fontWeight: 500,
  fontFamily: 'inherit',
  cursor: 'pointer',
};

const placeholderStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  flex: 1,
  minHeight: 220,
  padding: 40,
  color: MUTED,
  textAlign: 'center',
};

/**
 * Class-based rules for what inline styles cannot express: the two-column
 * layout collapsing on a narrow window, hover/focus states, and the
 * markdown the Anleitung is written in.
 *
 * Same approach as the register's `.mb-verification-md` block — index.html
 * applies a global `* { margin: 0; padding: 0 }`, which strips the indent
 * an <ol> needs to show its numbers at all.
 */
const guideCss = `
  .mb-guide-grid {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 296px minmax(0, 1fr);
  }
  .mb-guide-rail {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-right: 1px solid ${HAIRLINE};
    background: ${PAPER};
  }
  .mb-guide-detail {
    min-width: 0;
    overflow-y: auto;
    padding: 24px 28px 56px;
    display: flex;
    flex-direction: column;
  }
  /* Under ~880px the two columns would each be too narrow to do their job,
     so the rail becomes a capped list stacked above the criterion. */
  @media (max-width: 880px) {
    .mb-guide-grid { grid-template-columns: 1fr; grid-template-rows: minmax(0, 40vh) minmax(0, 1fr); }
    .mb-guide-rail { border-right: none; border-bottom: 1px solid ${HAIRLINE}; }
    .mb-guide-detail { padding: 18px 16px 40px; }
  }

  .mb-guide-search:focus { border-color: ${ACCENT_LINE}; box-shadow: 0 0 0 3px ${ACCENT_SOFT}; }
  .mb-guide-chapter:hover { color: ${INK_SOFT}; }
  .mb-guide-item:hover { background: ${RAISED} !important; }
  .mb-guide-item:focus-visible,
  .mb-guide-chapter:focus-visible,
  .mb-guide-btn:focus-visible { outline: 2px solid ${ACCENT}; outline-offset: -2px; }
  .mb-guide-btn:hover { filter: brightness(0.97); }

  .mb-guide-md > :first-child { margin-top: 0; }
  .mb-guide-md > :last-child { margin-bottom: 0; }
  .mb-guide-md p { margin: 0 0 10px; }
  /* Numbered steps as counter chips rather than plain digits: the reader is
     working down a list with his hands on the product, and needs to find
     his place again after every step. */
  .mb-guide-md ol {
    margin: 0 0 14px;
    padding: 0;
    list-style: none;
    counter-reset: mbstep;
  }
  /* The chip is positioned out of flow rather than made a grid column.
     A grid li turns every child into a grid item — including the inline
     <strong> and <em> that markdown puts *inside* a sentence, and the bare
     text around them into anonymous items. A step reading
     "öffne **Mandate → Übersicht** und prüfe …" then broke into three
     stacked blocks, the last of them wrapping one word per line in the
     26px marker column. Out-of-flow keeps the step a paragraph. */
  .mb-guide-md ol > li {
    counter-increment: mbstep;
    position: relative;
    padding-left: 39px;
    margin-bottom: 12px;
  }
  .mb-guide-md ol > li::before {
    content: counter(mbstep);
    position: absolute;
    left: 0;
    top: 1px;
    font-family: ${MONO};
    font-size: 11px;
    color: ${ACCENT};
    border: 1px solid ${HAIRLINE};
    background: ${RAISED};
    border-radius: 6px;
    width: 26px;
    height: 26px;
    display: grid;
    place-items: center;
  }
  /* Nested lists fall back to ordinary markers — chips inside chips read as
     a second numbering scheme rather than a sub-step. The padding the chip
     reserved has to go back too, or every sub-step sits 39px in. */
  .mb-guide-md ol ol, .mb-guide-md ul ol {
    padding-left: 20px; list-style: decimal outside; counter-reset: none;
  }
  .mb-guide-md ol ol > li, .mb-guide-md ul ol > li {
    display: list-item; position: static; padding-left: 0; margin-bottom: 4px;
  }
  .mb-guide-md ol ol > li::before, .mb-guide-md ul ol > li::before { content: none; }
  .mb-guide-md ul { margin: 0 0 12px; padding-left: 20px; list-style: disc outside; }
  .mb-guide-md ul li { margin-bottom: 5px; }
  .mb-guide-md h1, .mb-guide-md h2, .mb-guide-md h3 {
    font-size: 13.5px; font-weight: 700; margin: 18px 0 8px; color: ${INK};
  }
  .mb-guide-md strong { font-weight: 600; color: ${INK}; }
  .mb-guide-md a { color: ${ACCENT}; }
  .mb-guide-md code {
    font-family: ${MONO}; font-size: 12px;
    background: ${ACCENT_SOFT}; padding: 1px 5px; border-radius: 4px;
  }
  .mb-guide-md pre {
    background: #0f172a; color: #e2e8f0; padding: 12px 14px;
    border-radius: 8px; overflow-x: auto; margin: 0 0 12px; font-size: 12px;
  }
  .mb-guide-md pre code { background: none; padding: 0; color: inherit; }
  .mb-guide-md blockquote {
    border-left: 3px solid ${ACCENT_LINE}; margin: 0 0 12px;
    padding: 2px 12px; color: ${MUTED};
  }
  .mb-guide-md table { border-collapse: collapse; font-size: 12.5px; margin: 0 0 12px; }
  .mb-guide-md th, .mb-guide-md td {
    border: 1px solid ${HAIRLINE}; padding: 5px 9px; text-align: left;
  }
  .mb-guide-md th { background: ${ACCENT_SOFT}; font-weight: 600; }
  .mb-guide-md img { max-width: 100%; height: auto; border-radius: 8px; }

  @media (prefers-reduced-motion: reduce) {
    .mb-guide-grid * { transition: none !important; animation: none !important; }
  }
`;
