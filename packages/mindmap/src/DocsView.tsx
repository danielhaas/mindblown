/**
 * The Docs tab (#550) — the markdown files of the map's connected repo,
 * read in place.
 *
 * The plan lives in the map, but its specs, ADRs and READMEs live in the
 * repo; reading one meant leaving for the forge. This view lists every
 * `*.md` on the default branch and renders the one picked. Links between
 * docs stay inside the view, images come through the server (an <img src>
 * carries no token).
 *
 * In sync without a copy: the server re-reads the branch tree at most
 * every 15 s; this view re-lists on a `docs:updated` push broadcast and,
 * as a fallback for repos whose webhook lacks `push`, every minute while
 * the page is visible. The open doc reloads only when its blob sha moved.
 *
 * Editing (#552) never writes the default branch: "Propose change" sends
 * the whole new text with the blob sha it was based on, and the server
 * opens a branch + pull request. A doc that moved on meanwhile is a
 * conflict, and the draft stays in the editor.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useMindmapStore } from './store.js';
import * as api from './api.js';
import { baseName, defaultDoc, filterDocs, groupDocs, remarkHeadingIds, resolveRepoLink, restoreLineEndings, siblingWebUrl } from './docs.js';
import { formatSize } from './AttachmentsSection.js';
import { useCanEditMap } from './useCanEditMap.js';

// ── Palette (same slate + indigo every view carries) ────────────────

const PAPER = '#f8fafc';
const RAISED = '#ffffff';
const INK = '#1e293b';
const MUTED = '#64748b';
const FAINT = '#94a3b8';
const HAIRLINE = '#e2e8f0';
const ACCENT = '#4f46e5';
const ACCENT_SOFT = '#eef2ff';
const DANGER = '#b91c1c';

const POLL_MS = 60_000;

interface EditState {
  mapId: string;
  path: string;
  /** The blob the draft started from — the server refuses the proposal if the doc moved on. */
  baseSha: string;
  /** Text as loaded, line endings normalised to LF (a textarea only ever yields LF). */
  original: string;
  draft: string;
  /** The doc as loaded, kept only when it has CRLF endings: the proposal puts them back (`restoreLineEndings`). */
  raw?: string;
  message: string;
  preview: boolean;
}

/**
 * An unsaved draft outlives the view: switching tabs or maps unmounts it.
 * One draft per map, per browser tab (sessionStorage); try/catch because
 * storage can be full or blocked.
 */
const draftKey = (mapId: string) => `mb-docs-draft:${mapId}`;

function readDraft(mapId: string): EditState | null {
  try {
    const raw = sessionStorage.getItem(draftKey(mapId));
    const d = raw ? (JSON.parse(raw) as EditState & { crlf?: boolean }) : null;
    if (!d || d.mapId !== mapId || typeof d.draft !== 'string') return null;
    // A draft stored before `raw` existed said only "the doc was CRLF".
    if (d.crlf && d.raw === undefined) d.raw = d.original.replace(/\n/g, '\r\n');
    return { ...d, preview: false };
  } catch {
    return null;
  }
}

function writeDraft(mapId: string, edit: EditState | null) {
  try {
    if (edit) sessionStorage.setItem(draftKey(mapId), JSON.stringify(edit));
    else sessionStorage.removeItem(draftKey(mapId));
  } catch {
    // Not persisted (quota) — and an older stored draft must not come back
    // later as "your unsaved edit". The in-memory draft still works.
    try {
      sessionStorage.removeItem(draftKey(mapId));
    } catch {
      // Storage blocked altogether.
    }
  }
}

const MARKDOWN_PLUGINS = [remarkGfm, remarkHeadingIds];

interface Proposed {
  path: string;
  /** The version the edit was made against — tells the proposed edit apart from a later one of the same doc. */
  baseSha: string;
  number: number;
  url: string;
}

/**
 * A proposal outlives the view, like the draft: leaving the tab while the
 * PR is being opened must neither lose its link nor let the restored draft
 * open a second one. Per map — the view that is mounted when it settles
 * shows it; if none is, the next one does.
 */
const pendingProposals = new Map<string, Promise<Proposed>>();
const unseenProposals = new Map<string, Proposed>();

function startProposal(mapId: string, input: Parameters<typeof api.proposeRepoDocEdit>[1]): Promise<Proposed> {
  const p = api.proposeRepoDocEdit(mapId, input).then((res) => {
    // Even with the view gone: the draft is a PR now — unless the stored
    // draft is already a different edit, begun while this one was in flight.
    const stored = readDraft(mapId);
    if (!stored || (stored.path === input.path && stored.baseSha === input.baseSha)) writeDraft(mapId, null);
    const done = { path: res.path, baseSha: input.baseSha, ...res.pullRequest };
    unseenProposals.set(mapId, done);
    return done;
  });
  pendingProposals.set(mapId, p);
  const clear = () => {
    if (pendingProposals.get(mapId) === p) pendingProposals.delete(mapId);
  };
  p.then(clear, clear);
  return p;
}

export function DocsView() {
  const mapId = useMindmapStore((s) => s.currentMapId);
  // The server decides in the end (the propose route needs edit).
  const canEdit = useCanEditMap();
  const [edit, setEdit] = useState<EditState | null>(null);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<{ code?: string; message: string } | null>(null);
  const [proposed, setProposed] = useState<Proposed | null>(null);
  const [restored, setRestored] = useState(false);
  const dirty = !!edit && edit.draft !== edit.original;
  /** Set synchronously: two submits before a re-render (Ctrl+Enter repeat) must not open two PRs. */
  const inFlight = useRef(false);
  const [list, setList] = useState<api.RepoDocsList | null>(null);
  const [listError, setListError] = useState<{ code?: string; message: string } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [doc, setDoc] = useState<api.RepoDocText | null>(null);
  const [docError, setDocError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  /** Bumped to read the open doc again after a failed read. */
  const [retry, setRetry] = useState(0);
  const pendingHash = useRef<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef(mapId);
  mapRef.current = mapId;
  const listRef = useRef(list);
  listRef.current = list;
  const mounted = useRef(false);
  useEffect(() => {
    // Set here, not in useRef: StrictMode runs this cleanup and re-mounts.
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const loadList = useCallback(async () => {
    if (!mapId) return;
    try {
      const next = await api.listRepoDocs(mapId);
      // The map changed while this was in flight — not this view's list.
      if (mapRef.current !== mapId) return;
      // Same tree = nothing changed; keeping the object keeps the open doc mounted.
      setList((prev) => (prev && prev.treeSha === next.treeSha && prev.repo.branch === next.repo.branch ? prev : next));
      setListError(null);
    } catch (err) {
      if (mapRef.current !== mapId) return;
      // A failed re-list keeps what is on screen; only a first load shows the error.
      if (!listRef.current) setListError(err instanceof api.ApiError ? { code: err.code, message: err.message } : { message: String(err) });
    }
  }, [mapId]);

  /** Leaving the editor with changes asks first. */
  const dropEdit = () => {
    if (edit) writeDraft(edit.mapId, null);
    setEdit(null);
    setEditError(null);
    setRestored(false);
  };

  const leaveEdit = (): boolean => {
    if (dirty && !window.confirm('Discard your unsaved edit?')) return false;
    dropEdit();
    return true;
  };

  const leaveRef = useRef(leaveEdit);
  leaveRef.current = leaveEdit;

  const select = (path: string) => {
    if (edit && !leaveEdit()) return;
    setDocError(null);
    if (path === selected) setRetry((n) => n + 1);
    else setSelected(path);
  };


  // A closed tab or a reload loses even the stored draft's context — ask.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = ''; // older Chrome / Safari need it to show the prompt
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  // Keep a changed draft across tab and map switches. Removal is explicit
  // (dropEdit) — a null `edit` also means "just mounted, not restored yet".
  // Debounced: a large doc serialised on every keystroke would lag typing.
  // An unmount within the window flushes, so a quick tab switch keeps it.
  const latestDraft = useRef<{ edit: EditState | null; dirty: boolean }>({ edit, dirty });
  latestDraft.current = { edit, dirty };
  useEffect(() => {
    if (!edit) return;
    const t = setTimeout(() => writeDraft(edit.mapId, dirty ? edit : null), 400);
    return () => clearTimeout(t);
  }, [edit, dirty]);
  useEffect(
    () => () => {
      const { edit: last, dirty: lastDirty } = latestDraft.current;
      if (last) writeDraft(last.mapId, lastDirty ? last : null);
    },
    [],
  );

  const startEdit = () => {
    if (!doc || !mapId) return;
    const original = doc.text.replace(/\r\n/g, '\n');
    const raw = doc.text.includes('\r\n') ? doc.text : undefined;
    setEdit({ mapId, path: doc.path, baseSha: doc.sha, original, draft: original, raw, message: '', preview: false });
    setEditError(null);
    setProposed(null);
    setRestored(false);
  };

  /** Follow a proposal of `forMap` — one started here, or one still in flight from before a remount. */
  const awaitProposal = async (forMap: string, p: Promise<Proposed>) => {
    inFlight.current = true;
    setSaving(true);
    setEditError(null);
    try {
      const done = await p;
      // Gone, or showing another map: the view showing this map next picks it up.
      if (!mounted.current || mapRef.current !== forMap) return;
      unseenProposals.delete(forMap);
      setProposed(done);
      // Close the editor only on the edit that was proposed — not on one
      // of another doc started while the PR was being opened.
      const current = latestDraft.current.edit;
      if (!current || (current.path === done.path && current.baseSha === done.baseSha)) {
        setEdit(null);
        setRestored(false);
      }
    } catch (err) {
      if (!mounted.current || mapRef.current !== forMap) return;
      setEditError(err instanceof api.ApiError ? { code: err.code, message: err.message } : { message: String(err) });
      // The server just re-read the branch; re-list so "Discard and reload" gets the new version.
      if (err instanceof api.ApiError && err.code === 'CONFLICT') void loadList();
    } finally {
      if (mapRef.current === forMap) {
        inFlight.current = false;
        setSaving(false);
      }
    }
  };

  const propose = () => {
    if (!mapId || !edit || !dirty || inFlight.current || pendingProposals.has(mapId)) return;
    const p = startProposal(mapId, {
      path: edit.path,
      text: edit.raw === undefined ? edit.draft : restoreLineEndings(edit.raw, edit.draft),
      baseSha: edit.baseSha,
      message: edit.message.trim() || undefined,
    });
    void awaitProposal(mapId, p);
  };

  // A different map is a different repo: start over — with that map's
  // stored draft, if one was left there.
  useEffect(() => {
    const saved = mapId ? readDraft(mapId) : null;
    // A PR opened after the view was left (its draft is gone by then).
    // Dropped from `unseenProposals` once shown (below), not here — StrictMode runs this twice.
    const done = mapId ? unseenProposals.get(mapId) : undefined;
    const pending = mapId ? pendingProposals.get(mapId) : undefined;
    setList(null);
    listRef.current = null;
    setListError(null);
    setSelected(saved?.path ?? done?.path ?? null);
    setDoc(null);
    setDocError(null);
    setEdit(saved);
    setRestored(!!saved && !pending);
    setEditError(null);
    setProposed(done ?? null);
    inFlight.current = false;
    setSaving(false);
    if (mapId && pending) void awaitProposal(mapId, pending);
    void loadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadList]);

  useEffect(() => {
    if (proposed && mapId) unseenProposals.delete(mapId);
  }, [proposed, mapId]);

  useEffect(() => {
    const onPush = () => void loadList();
    const tick = setInterval(() => {
      if (document.visibilityState === 'visible') void loadList();
    }, POLL_MS);
    window.addEventListener('ws:docs', onPush);
    return () => {
      clearInterval(tick);
      window.removeEventListener('ws:docs', onPush);
    };
  }, [loadList]);

  // First list, or the open doc deleted upstream → the default doc. Not
  // while a draft is open: it stays on screen (see `editGone`).
  useEffect(() => {
    if (!list || edit) return;
    if (!selected || !list.docs.some((d) => d.path === selected)) setSelected(defaultDoc(list.docs));
  }, [list, selected, edit]);

  /** The doc being edited was deleted or renamed on the branch. */
  const editGone = !!edit && !!list && !list.docs.some((d) => d.path === edit.path);

  const selectedSha = list?.docs.find((d) => d.path === selected)?.sha ?? null;

  // Load when the pick changes or its content does (sha moved).
  useEffect(() => {
    if (!mapId || !selected || !selectedSha) return;
    if (doc?.path === selected && doc.sha === selectedSha) return;
    let cancelled = false;
    api.readRepoDoc(mapId, selected).then(
      (d) => {
        if (cancelled) return;
        const isNewDoc = doc?.path !== d.path;
        setDoc(d);
        setDocError(null);
        if (isNewDoc && !pendingHash.current) bodyRef.current?.scrollTo({ top: 0 });
      },
      (err) => {
        if (!cancelled) setDocError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      cancelled = true;
    };
    // `doc` is read only to skip a redundant fetch; it must not retrigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapId, selected, selectedSha, retry]);

  // A link to `other.md#section` lands on the section once the doc is in.
  useEffect(() => {
    const hash = pendingHash.current;
    if (!doc || !hash) return;
    pendingHash.current = null;
    requestAnimationFrame(() => scrollToAnchor(bodyRef.current, hash));
  }, [doc]);

  const docPaths = useMemo(() => new Set(list?.docs.map((d) => d.path) ?? []), [list]);

  // The renderers below read the current doc through this ref, so their
  // identities never change: a new identity makes React remount every
  // heading, link and image of the open doc (images blank and refetch).
  const live = useRef({ doc, docPaths, mapId, treeSha: list?.treeSha ?? '' });
  live.current = { doc, docPaths, mapId, treeSha: list?.treeSha ?? '' };

  // Heading ids come from `remarkHeadingIds` (GitHub's numbering of repeats).
  const components = useMemo<Components>(() => {
    return {
      a: ({ node: _node, href, children, ...props }) => {
        if (href?.startsWith('#')) {
          return (
            <a {...props} href={href} onClick={(e) => { e.preventDefault(); scrollToAnchor(bodyRef.current, href.slice(1)); }}>
              {children}
            </a>
          );
        }
        const { doc, docPaths } = live.current;
        const target = doc && href ? resolveRepoLink(doc.path, href) : null;
        if (target && docPaths.has(target.path)) {
          return (
            <a
              {...props}
              href={href}
              onClick={(e) => {
                e.preventDefault();
                if (target.path === live.current.doc?.path) {
                  if (target.hash) scrollToAnchor(bodyRef.current, target.hash);
                  return;
                }
                // A link clicked in the editor's preview leaves the draft too.
                if (!leaveRef.current()) return;
                pendingHash.current = target.hash;
                setDocError(null);
                setSelected(target.path);
              }}
            >
              {children}
            </a>
          );
        }
        // Anything else leaves the app — a new tab keeps the reader's place.
        // A repo file that is no doc (source, a PDF) opens on the forge.
        const outside = target && doc ? siblingWebUrl(doc.webUrl, doc.path, target) ?? href : href;
        return (
          <a {...props} href={outside} target="_blank" rel="noreferrer">
            {children}
          </a>
        );
      },
      img: ({ node: _node, src, alt, ...props }) => {
        const { doc, mapId, treeSha } = live.current;
        const target = doc && typeof src === 'string' ? resolveRepoLink(doc.path, src) : null;
        if (!target || !mapId) return <img {...props} src={typeof src === 'string' ? src : undefined} alt={alt ?? ''} style={{ maxWidth: '100%' }} />;
        // Keyed: the renderer is stable now, so a slot would otherwise keep the previous image's state.
        // `version` re-asks on every new tree: the server answers 304 unless the image changed.
        return <RepoImage key={`${mapId}:${target.path}`} mapId={mapId} path={target.path} version={treeSha} alt={alt ?? ''} />;
      },
    };
  }, []);

  if (listError) {
    return (
      <div style={containerStyle}>
        <Placeholder
          title={listError.code === 'NO_REPO' ? 'No repository connected' : 'Could not read the repository'}
          body={
            listError.code === 'NO_REPO'
              ? "Connect this map to a GitHub or Gitea repo (account menu → GitHub integration…) and its markdown files show up here."
              : listError.message
          }
        />
      </div>
    );
  }
  if (!list) {
    return (
      <div style={containerStyle}>
        <Placeholder title="Loading docs…" body="" />
      </div>
    );
  }

  const groups = groupDocs(filterDocs(list.docs, filter));

  return (
    <div style={containerStyle}>
      <style>{docsCss}</style>
      <div className="mb-docs-grid">
        <aside className="mb-docs-rail">
          <div style={{ padding: '12px 14px 8px', borderBottom: `1px solid ${HAIRLINE}` }}>
            <a href={list.repo.webUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12, fontWeight: 600, color: INK, textDecoration: 'none' }}>
              {list.repo.owner}/{list.repo.name}
            </a>
            <span style={{ fontSize: 11, color: FAINT }}> @ {list.repo.branch}</span>
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={`Filter ${list.docs.length} docs…`}
              aria-label="Filter docs"
              style={searchStyle}
            />
          </div>
          <div style={{ overflow: 'auto', flex: 1, padding: '6px 0 12px' }}>
            {groups.length === 0 && (
              <div style={{ padding: '10px 14px', fontSize: 12, color: MUTED }}>
                {list.docs.length === 0 ? 'No markdown files on this branch.' : 'Nothing matches.'}
              </div>
            )}
            {groups.map((g) => (
              <div key={g.dir}>
                {g.dir && <div style={dirStyle}>{g.dir}/</div>}
                {g.docs.map((d) => (
                  <button
                    key={d.path}
                    type="button"
                    className="mb-docs-item"
                    onClick={() => select(d.path)}
                    title={d.path}
                    style={{
                      paddingLeft: g.dir ? 24 : 14,
                      background: d.path === selected ? ACCENT_SOFT : 'transparent',
                      color: d.path === selected ? ACCENT : INK,
                      fontWeight: d.path === selected ? 600 : 400,
                    }}
                  >
                    {baseName(d.path)}
                  </button>
                ))}
              </div>
            ))}
            {list.truncated && (
              <div style={{ padding: '10px 14px', fontSize: 11, color: DANGER }}>
                The repository is too large to list in full — some docs are missing.
              </div>
            )}
          </div>
        </aside>

        <main className="mb-docs-body" ref={bodyRef}>
          {edit && editGone ? (
            <div className="mb-docs-editor">
              <div role="alert" style={{ ...bannerStyle, background: '#fef2f2', borderColor: '#fecaca', color: DANGER }}>
                <span>
                  {edit.path} no longer exists on {list.repo.branch} — it was deleted or renamed. Copy your text below before you discard it.
                </span>
                <button
                  type="button"
                  onClick={() => {
                    if (!window.confirm('Discard your unsaved edit?')) return;
                    dropEdit();
                  }}
                  style={linkButtonStyle}
                >
                  Discard
                </button>
              </div>
              <textarea className="mb-docs-textarea" value={edit.draft} readOnly aria-label={`Unsaved text of ${edit.path}`} />
            </div>
          ) : doc && doc.path === selected ? (
            <>
              {proposed && proposed.path === doc.path && (
                <div role="status" style={bannerStyle}>
                  <span>
                    Pull request #{proposed.number} opened — the change lands on {list.repo.branch} when it is merged.
                  </span>
                  <a href={proposed.url} target="_blank" rel="noreferrer" style={{ color: ACCENT, fontWeight: 600, textDecoration: 'none' }}>
                    View PR ↗
                  </a>
                  <button type="button" aria-label="Dismiss" onClick={() => setProposed(null)} style={linkButtonStyle}>
                    ×
                  </button>
                </div>
              )}
              <div style={docHeaderStyle}>
                <span style={{ fontFamily: 'Menlo, Monaco, monospace', fontSize: 12, color: MUTED }}>{doc.path}</span>
                <span style={{ fontSize: 11, color: FAINT }}>{formatSize(doc.size)}</span>
                <span style={{ marginLeft: 'auto', display: 'flex', gap: 14, alignItems: 'baseline' }}>
                  {canEdit && !edit && doc.utf8 !== false && (
                    <button type="button" onClick={startEdit} style={linkButtonStyle}>
                      Edit
                    </button>
                  )}
                  {canEdit && !edit && doc.utf8 === false && (
                    <span style={{ fontSize: 12, color: FAINT }} title="This file is not UTF-8 text; editing it here would corrupt it">
                      Not UTF-8 — edit in the repo
                    </span>
                  )}
                  <a href={doc.webUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: ACCENT, textDecoration: 'none' }}>
                    Open in repo ↗
                  </a>
                </span>
              </div>
              {edit && edit.path === doc.path ? (
                <div className="mb-docs-editor">
                  <div className="mb-docs-editor-bar">
                    <div role="tablist" style={{ display: 'flex', gap: 4 }}>
                      {(['Write', 'Preview'] as const).map((label) => {
                        const active = (label === 'Preview') === edit.preview;
                        return (
                          <button
                            key={label}
                            type="button"
                            role="tab"
                            aria-selected={active}
                            onClick={() => setEdit({ ...edit, preview: label === 'Preview' })}
                            style={{ ...tabStyle, background: active ? ACCENT_SOFT : 'transparent', color: active ? ACCENT : MUTED }}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                    <input
                      value={edit.message}
                      onChange={(e) => setEdit({ ...edit, message: e.target.value })}
                      placeholder={`docs: update ${edit.path}`}
                      aria-label="Change summary"
                      style={messageStyle}
                    />
                    <button type="button" onClick={() => leaveEdit()} disabled={saving} style={secondaryButtonStyle}>
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={propose}
                      disabled={saving || !dirty}
                      title={dirty ? `Opens a pull request against ${list.repo.branch}` : 'Nothing changed yet'}
                      style={{ ...primaryButtonStyle, opacity: saving || !dirty ? 0.5 : 1 }}
                    >
                      {saving ? 'Opening PR…' : 'Propose change'}
                    </button>
                  </div>
                  {restored && !editError && (
                    <div role="status" style={bannerStyle}>
                      <span>Restored your unsaved edit of {edit.path}.</span>
                    </div>
                  )}
                  {editError && (
                    <div role="alert" style={{ ...bannerStyle, background: '#fef2f2', borderColor: '#fecaca', color: DANGER }}>
                      <span>
                        {editError.code === 'CONFLICT'
                          ? `${edit.path} changed on ${list.repo.branch} since you started. Your text is still here — copy it, then discard and reapply it to the latest version.`
                          : editError.message}
                      </span>
                      {editError.code === 'CONFLICT' && (
                        <button
                          type="button"
                          onClick={() => {
                            dropEdit();
                            // The new sha reaches the reload effect through a fresh list.
                            void loadList();
                            setRetry((n) => n + 1);
                          }}
                          style={linkButtonStyle}
                        >
                          Discard and reload
                        </button>
                      )}
                    </div>
                  )}
                  {edit.preview ? (
                    <article className="mb-docs-md">
                      <ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS} components={components}>
                        {edit.draft}
                      </ReactMarkdown>
                    </article>
                  ) : (
                    <textarea
                      className="mb-docs-textarea"
                      value={edit.draft}
                      // Text typed while the PR is being opened would be dropped with the draft on success.
                      readOnly={saving}
                      onChange={(e) => setEdit({ ...edit, draft: e.target.value })}
                      onKeyDown={(e) => {
                        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') propose();
                      }}
                      aria-label={`Edit ${edit.path}`}
                      spellCheck
                      autoFocus
                    />
                  )}
                </div>
              ) : (
                <article className="mb-docs-md">
                  <ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS} components={components}>
                    {doc.text}
                  </ReactMarkdown>
                </article>
              )}
            </>
          ) : docError ? (
            <Placeholder title="Could not open this doc" body={docError} />
          ) : selected ? (
            <Placeholder title="Loading…" body="" />
          ) : (
            <Placeholder title="No docs" body="This branch has no markdown files yet." />
          )}
        </main>
      </div>
    </div>
  );
}

/**
 * A repo image, fetched with the token and shown from an object URL.
 * A new `version` (the branch tree) fetches again; the old picture stays
 * until the new one is in, so an unchanged image never blinks.
 */
function RepoImage({ mapId, path, version, alt }: { mapId: string; path: string; version: string; alt: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const shown = useRef(false);
  shown.current = !!url;
  useEffect(() => {
    let cancelled = false;
    api.fetchRepoImage(mapId, path).then(
      (blob) => {
        if (cancelled) return;
        setUrl(URL.createObjectURL(blob));
        setFailed(false);
      },
      (err) => {
        if (cancelled) return;
        // A blip on a re-check keeps the picture; only a deleted image goes.
        if (!shown.current || (err instanceof api.ApiError && err.status === 404)) {
          setUrl(null);
          setFailed(true);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [mapId, path, version]);
  // Each object URL is let go once it is replaced or the image unmounts.
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );
  if (failed) return <span style={{ color: FAINT, fontSize: 12 }}>[image: {alt || path}]</span>;
  return url ? <img src={url} alt={alt} style={{ maxWidth: '100%' }} /> : null;
}

function scrollToAnchor(container: HTMLElement | null, hash: string) {
  let id = hash;
  try {
    id = decodeURIComponent(hash);
  } catch {
    // Keep it as written.
  }
  container?.querySelector(`[id="${CSS.escape(id.toLowerCase())}"]`)?.scrollIntoView({ block: 'start' });
}

function Placeholder({ title, body }: { title: string; body: string }) {
  return (
    <div style={{ padding: '48px 24px', textAlign: 'center', color: MUTED }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: INK, marginBottom: 6 }}>{title}</div>
      {body && <div style={{ fontSize: 13, maxWidth: 360, margin: '0 auto', lineHeight: 1.6 }}>{body}</div>}
    </div>
  );
}

// ── Styles ───────────────────────────────────────────────────────

const containerStyle: React.CSSProperties = {
  height: '100%',
  background: PAPER,
  overflow: 'hidden',
};

const searchStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  boxSizing: 'border-box',
  marginTop: 8,
  padding: '5px 8px',
  fontSize: 12,
  border: `1px solid ${HAIRLINE}`,
  borderRadius: 6,
  background: RAISED,
  color: INK,
};

const dirStyle: React.CSSProperties = {
  padding: '8px 14px 2px',
  fontSize: 11,
  fontWeight: 600,
  color: MUTED,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const bannerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  flexWrap: 'wrap',
  gap: 12,
  padding: '8px 12px',
  marginBottom: 14,
  fontSize: 13,
  color: INK,
  background: ACCENT_SOFT,
  border: '1px solid #c7d2fe',
  borderRadius: 8,
};

const linkButtonStyle: React.CSSProperties = {
  border: 'none',
  background: 'none',
  padding: 0,
  fontSize: 12,
  fontWeight: 600,
  color: ACCENT,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const tabStyle: React.CSSProperties = {
  border: 'none',
  borderRadius: 6,
  padding: '4px 10px',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const messageStyle: React.CSSProperties = {
  flex: '1 1 200px',
  minWidth: 0,
  padding: '5px 8px',
  fontSize: 12,
  border: `1px solid ${HAIRLINE}`,
  borderRadius: 6,
  background: RAISED,
  color: INK,
};

const secondaryButtonStyle: React.CSSProperties = {
  padding: '5px 12px',
  fontSize: 12,
  fontWeight: 600,
  border: `1px solid ${HAIRLINE}`,
  borderRadius: 6,
  background: RAISED,
  color: INK,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const primaryButtonStyle: React.CSSProperties = {
  ...secondaryButtonStyle,
  border: `1px solid ${ACCENT}`,
  background: ACCENT,
  color: '#fff',
};

const docHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 10,
  padding: '0 0 12px',
  marginBottom: 20,
  borderBottom: `1px solid ${HAIRLINE}`,
};

const docsCss = `
  .mb-docs-grid { display: grid; grid-template-columns: 260px minmax(0, 1fr); height: 100%; }
  .mb-docs-rail { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid ${HAIRLINE}; background: ${RAISED}; }
  .mb-docs-item { display: block; width: 100%; text-align: left; border: none; padding: 4px 14px; font-size: 12.5px; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: inherit; }
  .mb-docs-item:hover { background: ${PAPER}; }
  .mb-docs-body { overflow: auto; padding: 24px 32px 64px; min-height: 0; }
  .mb-docs-md { max-width: 860px; font-size: 14px; line-height: 1.65; color: ${INK}; }
  .mb-docs-md h1 { font-size: 26px; font-weight: 700; margin: 0 0 16px; color: #0f172a; }
  .mb-docs-md h2 { font-size: 20px; font-weight: 700; margin: 32px 0 12px; color: #0f172a; padding-bottom: 6px; border-bottom: 1px solid ${HAIRLINE}; }
  .mb-docs-md h3 { font-size: 16px; font-weight: 600; margin: 24px 0 8px; color: #0f172a; }
  .mb-docs-md h4 { font-size: 14px; font-weight: 600; margin: 20px 0 6px; color: #0f172a; }
  .mb-docs-md p { margin: 0 0 14px; }
  .mb-docs-md ul, .mb-docs-md ol { margin: 0 0 14px; padding-left: 24px; }
  .mb-docs-md li { margin-bottom: 4px; }
  .mb-docs-md a { color: ${ACCENT}; text-decoration: none; }
  .mb-docs-md a:hover { text-decoration: underline; }
  .mb-docs-md code { font-family: Menlo, Monaco, monospace; font-size: 12.5px; background: #f1f5f9; padding: 1px 5px; border-radius: 3px; color: #0f172a; }
  .mb-docs-md pre { background: #0f172a; color: #e2e8f0; padding: 14px 16px; border-radius: 8px; overflow-x: auto; margin: 0 0 16px; }
  .mb-docs-md pre code { background: none; padding: 0; color: inherit; font-size: 12px; }
  .mb-docs-md blockquote { border-left: 3px solid #cbd5e1; margin: 0 0 14px; padding: 2px 14px; color: #475569; }
  .mb-docs-md table { border-collapse: collapse; margin: 0 0 16px; font-size: 13px; display: block; overflow-x: auto; }
  .mb-docs-md th, .mb-docs-md td { border: 1px solid ${HAIRLINE}; padding: 6px 10px; text-align: left; vertical-align: top; }
  .mb-docs-md th { background: ${PAPER}; font-weight: 600; }
  .mb-docs-md hr { border: none; border-top: 1px solid ${HAIRLINE}; margin: 28px 0; }
  .mb-docs-md img { max-width: 100%; }
  .mb-docs-editor { max-width: 860px; }
  .mb-docs-editor-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 12px; }
  .mb-docs-textarea { display: block; width: 100%; box-sizing: border-box; min-height: 60vh; padding: 12px 14px; font-family: Menlo, Monaco, monospace; font-size: 13px; line-height: 1.55; color: ${INK}; background: ${RAISED}; border: 1px solid ${HAIRLINE}; border-radius: 8px; resize: vertical; }
  .mb-docs-textarea:focus { outline: 2px solid #c7d2fe; border-color: ${ACCENT}; }
  @media (max-width: 760px) {
    .mb-docs-grid { grid-template-columns: 1fr; grid-template-rows: minmax(0, 35vh) minmax(0, 1fr); }
    .mb-docs-rail { border-right: none; border-bottom: 1px solid ${HAIRLINE}; }
    .mb-docs-body { padding: 16px; }
  }
`;
