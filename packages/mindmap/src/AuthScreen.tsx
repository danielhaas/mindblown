import { useState } from 'react';
import { useMindmapStore } from './store.js';

// Read ?email= and ?mode=register off the URL so invite links can prefill the
// register form and skip the login/register toggle.
function readInviteParams(): { email: string; mode: 'login' | 'register'; invited: boolean } {
  if (typeof window === 'undefined') return { email: '', mode: 'login', invited: false };
  const params = new URLSearchParams(window.location.search);
  const email = params.get('email') ?? '';
  const mode = params.get('mode') === 'register' ? 'register' : 'login';
  return { email, mode, invited: email !== '' && mode === 'register' };
}

export function AuthScreen() {
  const initial = readInviteParams();
  const [mode, setMode] = useState<'login' | 'register'>(initial.mode);
  const [email, setEmail] = useState(initial.email);
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const invited = initial.invited;

  const login = useMindmapStore((s) => s.login);
  const register = useMindmapStore((s) => s.register);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (mode === 'login') {
        await login(email, password);
      } else {
        await register(email, password, name);
      }
    } catch (err: any) {
      setError(err.message ?? 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#f8fafc',
      }}
    >
      <div
        style={{
          width: 400,
          maxWidth: '90vw',
          background: '#fff',
          borderRadius: 16,
          boxShadow: '0 4px 24px rgba(0,0,0,0.06)',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{ padding: '28px 28px 16px', textAlign: 'center' }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#1e293b' }}>
            MindBlown
          </h1>
          <p style={{ margin: '6px 0 0', fontSize: 13, color: '#94a3b8' }}>
            {mode === 'login' ? 'Sign in to your account' : 'Create a new account'}
          </p>
        </div>

        {/* Toggle */}
        <div
          style={{
            display: 'flex',
            margin: '0 28px',
            background: '#f1f5f9',
            borderRadius: 6,
            padding: 2,
            gap: 1,
          }}
        >
          {(['login', 'register'] as const).map((m) => (
            <button
              key={m}
              onClick={() => { setMode(m); setError(null); }}
              style={{
                flex: 1,
                fontSize: 12,
                fontWeight: mode === m ? 600 : 500,
                color: mode === m ? '#1e293b' : '#64748b',
                background: mode === m ? '#fff' : 'transparent',
                border: 'none',
                borderRadius: 4,
                padding: '6px 0',
                cursor: 'pointer',
                fontFamily: 'inherit',
                boxShadow: mode === m ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
                transition: 'all 0.15s',
              }}
            >
              {m === 'login' ? 'Sign In' : 'Register'}
            </button>
          ))}
        </div>

        {/* Invitation banner — shown when the user arrived via an invite link */}
        {invited && mode === 'register' && (
          <div
            style={{
              margin: '12px 28px 0',
              padding: '10px 12px',
              borderRadius: 6,
              background: '#eef2ff',
              border: '1px solid #c7d2fe',
              color: '#3730a3',
              fontSize: 12,
              lineHeight: 1.5,
            }}
          >
            You've been invited to MindBlown. Sign up with <strong>{email}</strong> to
            accept the invitation and see the map that was shared with you.
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit} style={{ padding: '20px 28px 28px' }}>
          {error && (
            <div
              style={{
                marginBottom: 14,
                padding: '8px 12px',
                borderRadius: 6,
                background: '#fef2f2',
                border: '1px solid #fecaca',
                color: '#991b1b',
                fontSize: 12,
              }}
            >
              {error}
            </div>
          )}

          {mode === 'register' && (
            <div style={{ marginBottom: 12 }}>
              <label
                style={{
                  display: 'block',
                  fontSize: 11,
                  fontWeight: 600,
                  color: '#64748b',
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                  marginBottom: 4,
                }}
              >
                Name
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
                required
                style={{
                  width: '100%',
                  padding: '8px 12px',
                  border: '1px solid #e2e8f0',
                  borderRadius: 6,
                  fontSize: 13,
                  color: '#1e293b',
                  fontFamily: 'inherit',
                  background: '#fff',
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
            </div>
          )}

          <div style={{ marginBottom: 12 }}>
            <label
              style={{
                display: 'block',
                fontSize: 11,
                fontWeight: 600,
                color: '#64748b',
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                marginBottom: 4,
              }}
            >
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
              style={{
                width: '100%',
                padding: '8px 12px',
                border: '1px solid #e2e8f0',
                borderRadius: 6,
                fontSize: 13,
                color: '#1e293b',
                fontFamily: 'inherit',
                background: '#fff',
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
          </div>

          <div style={{ marginBottom: 20 }}>
            <label
              style={{
                display: 'block',
                fontSize: 11,
                fontWeight: 600,
                color: '#64748b',
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                marginBottom: 4,
              }}
            >
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter password"
              required
              minLength={4}
              style={{
                width: '100%',
                padding: '8px 12px',
                border: '1px solid #e2e8f0',
                borderRadius: 6,
                fontSize: 13,
                color: '#1e293b',
                fontFamily: 'inherit',
                background: '#fff',
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
          </div>

          <button
            type="submit"
            disabled={submitting}
            style={{
              width: '100%',
              padding: '10px 0',
              background: submitting ? '#a5b4fc' : '#4f46e5',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              fontSize: 14,
              fontWeight: 600,
              cursor: submitting ? 'default' : 'pointer',
              fontFamily: 'inherit',
              transition: 'background 0.15s',
            }}
          >
            {submitting
              ? 'Please wait...'
              : mode === 'login'
                ? 'Sign In'
                : 'Create Account'}
          </button>
        </form>
      </div>
    </div>
  );
}
