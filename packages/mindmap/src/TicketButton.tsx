import { useState } from 'react';
import { submitFeedbackTicket } from './api.js';

export function TicketButton() {
  const [isOpen, setIsOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setTitle('');
    setDescription('');
    setError(null);
    setSuccess(null);
  };

  const close = () => {
    setIsOpen(false);
    reset();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed || loading) return;

    setLoading(true);
    setError(null);
    try {
      const res = await submitFeedbackTicket({
        title: trimmed,
        description: description.trim(),
        page: window.location.href,
      });
      setSuccess(`Ticket #${res.issueNumber} created`);
      setTitle('');
      setDescription('');
      setTimeout(() => {
        setIsOpen(false);
        setSuccess(null);
      }, 1800);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create ticket');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <button
        onClick={() => setIsOpen(true)}
        title="Report an issue"
        aria-label="Report an issue"
        style={{
          position: 'fixed',
          bottom: 20,
          right: 20,
          zIndex: 40,
          width: 40,
          height: 40,
          borderRadius: '50%',
          border: 'none',
          background: '#4f46e5',
          color: '#fff',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: '0 4px 12px rgba(79,70,229,0.35)',
          transition: 'background 0.15s, transform 0.15s',
        }}
        onMouseOver={(e) => {
          e.currentTarget.style.background = '#4338ca';
          e.currentTarget.style.transform = 'scale(1.05)';
        }}
        onMouseOut={(e) => {
          e.currentTarget.style.background = '#4f46e5';
          e.currentTarget.style.transform = 'scale(1)';
        }}
      >
        <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 9a2 2 0 01-2 2H6l-3 3V4a2 2 0 012-2h7a2 2 0 012 2v5z" />
        </svg>
      </button>

      {isOpen && (
        <div
          onClick={close}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15,23,42,0.4)',
            zIndex: 100,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 440,
              maxWidth: '90vw',
              background: '#fff',
              borderRadius: 12,
              boxShadow: '0 10px 40px rgba(0,0,0,0.18)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                padding: '14px 18px',
                borderBottom: '1px solid #f1f5f9',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: '#1e293b' }}>
                Report an issue
              </h2>
              <button
                onClick={close}
                aria-label="Close"
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#94a3b8',
                  cursor: 'pointer',
                  fontSize: 16,
                  padding: '2px 6px',
                  fontFamily: 'inherit',
                }}
              >
                x
              </button>
            </div>

            <div style={{ padding: 18 }}>
              {success ? (
                <div
                  style={{
                    padding: '20px 0',
                    textAlign: 'center',
                    color: '#166534',
                    fontSize: 14,
                    fontWeight: 600,
                  }}
                >
                  {success}
                </div>
              ) : (
                <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <input
                    type="text"
                    placeholder="Brief title..."
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    onKeyDown={(e) => e.stopPropagation()}
                    autoFocus
                    style={{
                      width: '100%',
                      padding: '8px 10px',
                      border: '1px solid #e2e8f0',
                      borderRadius: 6,
                      fontSize: 13,
                      fontFamily: 'inherit',
                      outline: 'none',
                      boxSizing: 'border-box',
                    }}
                  />
                  <textarea
                    placeholder="What happened? (optional)"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    onKeyDown={(e) => e.stopPropagation()}
                    rows={4}
                    style={{
                      width: '100%',
                      padding: '8px 10px',
                      border: '1px solid #e2e8f0',
                      borderRadius: 6,
                      fontSize: 13,
                      fontFamily: 'inherit',
                      resize: 'vertical',
                      outline: 'none',
                      boxSizing: 'border-box',
                    }}
                  />
                  {error && (
                    <div style={{ fontSize: 12, color: '#991b1b' }}>{error}</div>
                  )}
                  <button
                    type="submit"
                    disabled={loading || !title.trim()}
                    style={{
                      padding: '8px 14px',
                      borderRadius: 6,
                      border: 'none',
                      background: loading || !title.trim() ? '#cbd5e1' : '#4f46e5',
                      color: '#fff',
                      fontSize: 13,
                      fontWeight: 600,
                      fontFamily: 'inherit',
                      cursor: loading || !title.trim() ? 'default' : 'pointer',
                      transition: 'background 0.15s',
                    }}
                  >
                    {loading ? 'Submitting...' : 'Submit'}
                  </button>
                </form>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
