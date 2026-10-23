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
import { baseName, defaultDoc, filterDocs, groupDocs, headingSlug, resolveRepoLink, siblingWebUrl } from './docs.js';
import { formatSize } from './AttachmentsSection.js';

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
  path: string;
  /** The blob the draft started from — the server refuses the proposal if the doc moved on. */
  baseSha: string;
  original: string;
  draft: string;
  message: string;
  preview: boolean;
}

export function DocsView() {
  const mapId = useMindmapStore((s) => s.currentMapId);
  const map = useMindmapStore((s) => s.currentMap);
  const user = useMindmapStore((s) => s.user);
  const members = useMindmapStore((s) => s.members);
  const membersMapId = useMindmapStore((s) => s.membersMapId);
  const loadMembers = useMindmapStore((s) => s.loadMembers);
  const [edit, setEdit] = useState<EditState | null>(null);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<{ code?: string; message: string } | null>(null);
  const [proposed, setProposed] = useState<{ path: string; number: number; url: string } | null>(null);
  const dirty = !!edit && edit.draft !== edit.original;
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
  const leaveEdit = (): boolean => {
    if (dirty && !window.confirm('Discard your unsaved edit?')) return false;
    setEdit(null);
    setEditError(null);
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

  // Same rule as the server's getPermission: the creator is admin without a
  // permission row. The server decides in the end (the propose route needs edit).
  const canEdit =
    !!map &&
    ((user !== null && map.createdBy === user.id) ||
      (membersMapId === map.id && members.some((m) => m.userId === user?.id && (m.permission === 'edit' || m.permission === 'admin'))));
  useEffect(() => {
    if (mapId && membersMapId !== mapId) void loadMembers();
  }, [mapId, membersMapId, loadMembers]);

  // An unsaved draft survives neither a reload nor a closed tab — ask.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const startEdit = () => {
    if (!doc) return;
    setEdit({ path: doc.path, baseSha: doc.sha, original: doc.text, draft: doc.text, message: '', preview: false });
    setEditError(null);
    setProposed(null);
  };

  const propose = async () => {
    if (!mapId || !edit || !dirty) return;
    setSaving(true);
    setEditError(null);
    try {
      const res = await api.proposeRepoDocEdit(mapId, {
        path: edit.path,
        text: edit.draft,
        baseSha: edit.baseSha,
        message: edit.message.trim() || undefined,
      });
      setProposed({ path: res.path, ...res.pullRequest });
      setEdit(null);
    } catch (err) {
      setEditError(err instanceof api.ApiError ? { code: err.code, message: err.message } : { message: String(err) });
    } finally {
      setSaving(false);
    }
  };

  // A different map is a different repo: start over.
  useEffect(() => {
    setList(null);
    listRef.current = null;
    setListError(null);
    setSelected(null);
    setDoc(null);
    setDocError(null);
    setEdit(null);
    setEditError(null);
    setProposed(null);
    void loadList();
  }, [loadList]);

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

  // First list, or the open doc deleted upstream → the default doc.
  useEffect(() => {
    if (!list) return;
    if (!selected || !list.docs.some((d) => d.path === selected)) setSelected(defaultDoc(list.docs));
  }, [list, selected]);

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
  const live = useRef({ doc, docPaths, mapId });
  live.current = { doc, docPaths, mapId };

  const components = useMemo<Components>(() => {
    const heading = (Tag: 'h1' | 'h2' | 'h3' | 'h4') =>
      function Heading({ node: _node, children, ...props }: React.ComponentProps<typeof Tag> & { node?: unknown }) {
        return (
          <Tag id={headingSlug(textOf(children))} {...props}>
            {children}
          </Tag>
        );
      };
    return {
      h1: heading('h1'),
      h2: heading('h2'),
      h3: heading('h3'),
      h4: heading('h4'),
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
        const { doc, mapId } = live.current;
        const target = doc && typeof src === 'string' ? resolveRepoLink(doc.path, src) : null;
        if (!target || !mapId) return <img {...props} src={typeof src === 'string' ? src : undefined} alt={alt ?? ''} style={{ maxWidth: '100%' }} />;
        // Keyed: the renderer is stable now, so a slot would otherwise keep the previous image's state.
        return <RepoImage key={`${mapId}:${target.path}`} mapId={mapId} path={target.path} alt={alt ?? ''} />;
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
          {doc && doc.path === selected ? (
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
                  {canEdit && !edit && (
                    <button type="button" onClick={startEdit} style={linkButtonStyle}>
                      Edit
                    </button>
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
                      onClick={() => void propose()}
                      disabled={saving || !dirty}
                      title={dirty ? `Opens a pull request against ${list.repo.branch}` : 'Nothing changed yet'}
                      style={{ ...primaryButtonStyle, opacity: saving || !dirty ? 0.5 : 1 }}
                    >
                      {saving ? 'Opening PR…' : 'Propose change'}
                    </button>
                  </div>
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
                            setEdit(null);
                            setEditError(null);
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
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
                        {edit.draft}
                      </ReactMarkdown>
                    </article>
                  ) : (
                    <textarea
                      className="mb-docs-textarea"
                      value={edit.draft}
                      onChange={(e) => setEdit({ ...edit, draft: e.target.value })}
                      onKeyDown={(e) => {
                        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void propose();
                      }}
                      aria-label={`Edit ${edit.path}`}
                      spellCheck
                      autoFocus
                    />
                  )}
                </div>
              ) : (
                <article className="mb-docs-md">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
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

/** A repo image, fetched with the token and shown from an object URL. */
function RepoImage({ mapId, path, alt }: { mapId: string; path: string; alt: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let href: string | null = null;
    let cancelled = false;
    setUrl(null);
    setFailed(false);
    api.fetchRepoImage(mapId, path).then(
      (blob) => {
        if (cancelled) return;
        href = URL.createObjectURL(blob);
        setUrl(href);
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
      if (href) URL.revokeObjectURL(href);
    };
  }, [mapId, path]);
  if (failed) return <span style={{ color: FAINT, fontSize: 12 }}>[image: {alt || path}]</span>;
  return url ? <img src={url} alt={alt} style={{ maxWidth: '100%' }} /> : null;
}

function textOf(children: React.ReactNode): string {
  if (children == null || typeof children === 'boolean') return '';
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(textOf).join('');
  if (typeof children === 'object' && 'props' in children) return textOf((children.props as { children?: React.ReactNode }).children);
  return '';
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
