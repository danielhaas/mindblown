import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Props {
  onClose: () => void;
}

export function HelpOverlay({ onClose }: Props) {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/user-guide.md')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then(setMarkdown)
      .catch((e) => setError(e.message ?? 'Failed to load user guide'));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div style={backdropStyle}>
      <div style={panelStyle}>
        <div style={headerStyle}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#0f172a' }}>
              Help &middot; User Guide
            </h2>
            <span style={{ fontSize: 12, color: '#94a3b8' }}>Press Esc to close</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <a
              href="/user-guide.pdf"
              download="mindblown-user-guide.pdf"
              style={downloadBtnStyle}
            >
              Download PDF
            </a>
            <button onClick={onClose} style={closeBtnStyle} aria-label="Close">
              &times;
            </button>
          </div>
        </div>

        <div style={bodyStyle}>
          {error && (
            <div style={{ color: '#dc2626', fontSize: 13, padding: 16 }}>
              Failed to load the user guide: {error}
            </div>
          )}
          {!error && !markdown && (
            <div style={{ padding: 24, color: '#94a3b8', fontSize: 13 }}>Loading&hellip;</div>
          )}
          {markdown && (
            <div className="help-markdown" style={markdownStyle}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
            </div>
          )}
        </div>
      </div>
      <style>{markdownCss}</style>
    </div>
  );
}

const backdropStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(15, 23, 42, 0.45)',
  zIndex: 2500,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 24,
};

const panelStyle: React.CSSProperties = {
  width: 'min(900px, 100%)',
  maxHeight: '90vh',
  background: '#fff',
  borderRadius: 14,
  boxShadow: '0 16px 48px rgba(0,0,0,0.25)',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '16px 22px',
  borderBottom: '1px solid #e2e8f0',
  flexShrink: 0,
};

const bodyStyle: React.CSSProperties = {
  overflowY: 'auto',
  flex: 1,
};

const markdownStyle: React.CSSProperties = {
  padding: '24px 32px 48px',
  fontSize: 14,
  lineHeight: 1.65,
  color: '#1e293b',
  fontFamily: 'inherit',
};

const downloadBtnStyle: React.CSSProperties = {
  background: '#4f46e5',
  color: '#fff',
  padding: '7px 14px',
  borderRadius: 6,
  fontSize: 12,
  fontWeight: 600,
  textDecoration: 'none',
  fontFamily: 'inherit',
};

const closeBtnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  fontSize: 24,
  color: '#94a3b8',
  cursor: 'pointer',
  padding: '0 6px',
  lineHeight: 1,
};

const markdownCss = `
  .help-markdown h1 { font-size: 24px; font-weight: 700; margin: 0 0 16px; color: #0f172a; letter-spacing: -0.01em; }
  .help-markdown h2 { font-size: 19px; font-weight: 700; margin: 32px 0 12px; color: #0f172a; padding-bottom: 6px; border-bottom: 1px solid #e2e8f0; }
  .help-markdown h3 { font-size: 15px; font-weight: 600; margin: 24px 0 8px; color: #0f172a; }
  .help-markdown p { margin: 0 0 14px; }
  .help-markdown ul, .help-markdown ol { margin: 0 0 14px; padding-left: 24px; }
  .help-markdown li { margin-bottom: 4px; }
  .help-markdown a { color: #4f46e5; text-decoration: none; }
  .help-markdown a:hover { text-decoration: underline; }
  .help-markdown code { font-family: 'Menlo', 'Monaco', monospace; font-size: 12.5px; background: #f1f5f9; padding: 1px 5px; border-radius: 3px; color: #0f172a; }
  .help-markdown pre { background: #0f172a; color: #e2e8f0; padding: 14px 16px; border-radius: 8px; overflow-x: auto; margin: 0 0 16px; }
  .help-markdown pre code { background: none; padding: 0; color: inherit; font-size: 12px; }
  .help-markdown blockquote { border-left: 3px solid #cbd5e1; margin: 0 0 14px; padding: 2px 14px; color: #475569; font-style: italic; }
  .help-markdown table { border-collapse: collapse; margin: 0 0 16px; width: 100%; font-size: 13px; }
  .help-markdown th, .help-markdown td { border: 1px solid #e2e8f0; padding: 7px 11px; text-align: left; }
  .help-markdown th { background: #f8fafc; font-weight: 600; }
  .help-markdown hr { border: none; border-top: 1px solid #e2e8f0; margin: 32px 0; }
  .help-markdown strong { font-weight: 700; color: #0f172a; }
`;
