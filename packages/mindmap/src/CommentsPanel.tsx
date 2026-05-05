import { useCallback, useEffect, useRef, useState } from 'react';
import { useMindmapStore } from './store.js';
import * as api from './api.js';
import type { Comment } from './api.js';

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString();
}

export function CommentsPanel({
  mapId,
  nodeId,
  maxHeight = 240,
  hideHeader = false,
}: {
  mapId: string;
  nodeId: string;
  /** Max height (px) for the message list. Default 240 keeps the per-node
   *  comments compact inside PropertyPanel; pass a larger number (or
   *  '100%') for the map-wide chat surface. */
  maxHeight?: number | string;
  /** Hide the "Comments (N)" header — useful when the parent already
   *  provides its own header. */
  hideHeader?: boolean;
}) {
  const user = useMindmapStore((s) => s.user);
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);
  const [newText, setNewText] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const loadComments = useCallback(async () => {
    try {
      const data = await api.fetchComments(mapId, nodeId);
      setComments(data);
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, [mapId, nodeId]);

  useEffect(() => {
    setLoading(true);
    loadComments();
  }, [loadComments]);

  // Listen for WebSocket comment events
  useEffect(() => {
    const handleWsEvent = (e: CustomEvent) => {
      const msg = e.detail;
      if (msg.nodeId !== nodeId) return;
      if (msg.type === 'comment:created') {
        setComments((prev) => {
          if (prev.some((c) => c.id === msg.comment.id)) return prev;
          return [...prev, msg.comment];
        });
      } else if (msg.type === 'comment:updated') {
        setComments((prev) => prev.map((c) => c.id === msg.comment.id ? msg.comment : c));
      } else if (msg.type === 'comment:deleted') {
        setComments((prev) => prev.filter((c) => c.id !== msg.commentId));
      }
    };

    window.addEventListener('ws:comment' as any, handleWsEvent as any);
    return () => window.removeEventListener('ws:comment' as any, handleWsEvent as any);
  }, [nodeId]);

  const handleAdd = async () => {
    const text = newText.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    try {
      const comment = await api.createComment(mapId, nodeId, text);
      setComments((prev) => {
        if (prev.some((c) => c.id === comment.id)) return prev;
        return [...prev, comment];
      });
      setNewText('');
      setTimeout(() => {
        listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
      }, 50);
    } catch {
      // error
    } finally {
      setSubmitting(false);
    }
  };

  const handleUpdate = async (commentId: string) => {
    const text = editText.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    try {
      const updated = await api.updateComment(commentId, text);
      setComments((prev) => prev.map((c) => c.id === commentId ? updated : c));
      setEditingId(null);
    } catch {
      // error
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (commentId: string) => {
    if (!confirm('Delete this comment?')) return;
    try {
      await api.deleteComment(commentId);
      setComments((prev) => prev.filter((c) => c.id !== commentId));
    } catch {
      // error
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 0,
        height: '100%',
      }}
    >
      {!hideHeader && (
        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: '#64748b',
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            padding: '0 0 8px',
          }}
        >
          Comments ({comments.length})
        </div>
      )}

      {/* Comments list */}
      <div
        ref={listRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          minHeight: 0,
          maxHeight,
        }}
      >
        {loading && (
          <div style={{ fontSize: 12, color: '#94a3b8', padding: 8, textAlign: 'center' }}>
            Loading...
          </div>
        )}

        {!loading && comments.length === 0 && (
          <div style={{ fontSize: 12, color: '#94a3b8', padding: 8, textAlign: 'center' }}>
            No comments yet
          </div>
        )}

        {comments.map((comment) => {
          const isOwn = user?.id === comment.userId;
          const isEditing = editingId === comment.id;

          return (
            <div
              key={comment.id}
              style={{
                padding: '8px 10px',
                background: '#f8fafc',
                borderRadius: 6,
                border: '1px solid #f1f5f9',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: '#1e293b' }}>
                    {comment.userName ?? 'User'}
                  </span>
                  <span style={{ fontSize: 10, color: '#94a3b8' }}>
                    {formatTime(comment.createdAt)}
                  </span>
                </div>
                {isOwn && !isEditing && (
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button
                      onClick={() => {
                        setEditingId(comment.id);
                        setEditText(comment.text);
                      }}
                      style={{
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        padding: '2px 4px',
                        fontSize: 11,
                        color: '#64748b',
                        fontFamily: 'inherit',
                      }}
                      title="Edit"
                    >
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M12.146.854a.5.5 0 0 1 .708 0l2.292 2.292a.5.5 0 0 1 0 .708l-9.5 9.5a.5.5 0 0 1-.168.11l-4 1.5a.5.5 0 0 1-.638-.638l1.5-4a.5.5 0 0 1 .11-.168l9.5-9.5zM11.207 2.5 13.5 4.793 14.793 3.5 12.5 1.207 11.207 2.5zm1.586 3L10.5 3.207 3.5 10.207V10.5h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.293l7-7z" />
                      </svg>
                    </button>
                    <button
                      onClick={() => handleDelete(comment.id)}
                      style={{
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        padding: '2px 4px',
                        fontSize: 11,
                        color: '#dc2626',
                        fontFamily: 'inherit',
                      }}
                      title="Delete"
                    >
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z" />
                        <path fillRule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1 0-2h3a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1h3a1 1 0 0 1 0 2zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118z" />
                      </svg>
                    </button>
                  </div>
                )}
              </div>

              {isEditing ? (
                <div style={{ display: 'flex', gap: 4 }}>
                  <input
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Enter') handleUpdate(comment.id);
                      if (e.key === 'Escape') setEditingId(null);
                    }}
                    autoFocus
                    style={{
                      flex: 1,
                      padding: '4px 8px',
                      border: '1px solid #c7d2fe',
                      borderRadius: 4,
                      fontSize: 12,
                      fontFamily: 'inherit',
                      outline: 'none',
                    }}
                  />
                  <button
                    onClick={() => handleUpdate(comment.id)}
                    style={{
                      background: '#4f46e5',
                      color: '#fff',
                      border: 'none',
                      borderRadius: 4,
                      padding: '4px 8px',
                      fontSize: 11,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    Save
                  </button>
                  <button
                    onClick={() => setEditingId(null)}
                    style={{
                      background: '#f1f5f9',
                      color: '#64748b',
                      border: 'none',
                      borderRadius: 4,
                      padding: '4px 8px',
                      fontSize: 11,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <div style={{ fontSize: 12, color: '#334155', lineHeight: 1.4, whiteSpace: 'pre-wrap' }}>
                  {comment.text}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Add comment */}
      <div style={{ display: 'flex', gap: 6, paddingTop: 8, borderTop: '1px solid #f1f5f9' }}>
        <input
          value={newText}
          onChange={(e) => setNewText(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleAdd();
            }
          }}
          placeholder="Add a comment..."
          style={{
            flex: 1,
            padding: '7px 10px',
            border: '1px solid #e2e8f0',
            borderRadius: 6,
            fontSize: 12,
            color: '#1e293b',
            fontFamily: 'inherit',
            background: '#fff',
            outline: 'none',
            boxSizing: 'border-box',
          }}
        />
        <button
          onClick={handleAdd}
          disabled={submitting || !newText.trim()}
          style={{
            background: newText.trim() ? '#4f46e5' : '#e2e8f0',
            color: newText.trim() ? '#fff' : '#94a3b8',
            border: 'none',
            borderRadius: 6,
            padding: '7px 12px',
            fontSize: 12,
            fontWeight: 600,
            cursor: newText.trim() ? 'pointer' : 'default',
            fontFamily: 'inherit',
            transition: 'all 0.15s',
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
}
