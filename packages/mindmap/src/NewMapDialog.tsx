/**
 * New-map dialog: name plus the map's AI policy (#375), asked up front so a
 * private project never spends a single request on a cloud model before its
 * owner had the choice. Replaces the old `prompt('Map name:')`.
 */
import { useEffect, useRef, useState } from 'react';
import type { AiPolicy } from '@mindblown/core';

const POLICIES: Array<{ value: AiPolicy; label: string; hint: string }> = [
  { value: 'any', label: 'Any provider', hint: 'Follows the server-wide AI provider. Content may reach a cloud model.' },
  { value: 'local', label: 'Local model only', hint: 'Only the self-hosted model, never the cloud. Off if none is configured.' },
  { value: 'none', label: 'No AI', hint: 'No chat, breakdown, estimates, triage or embeddings for this map.' },
];

export function NewMapDialog({
  onCreate,
  onClose,
}: {
  onCreate: (name: string, aiPolicy: AiPolicy) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [policy, setPolicy] = useState<AiPolicy>('any');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onCreate(trimmed, policy);
  };

  return (
    <div
      role="dialog"
      aria-label="New map"
      data-testid="new-map-dialog"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(15,23,42,0.35)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); submit(); }}
        style={{
          width: 420, maxWidth: 'calc(100vw - 32px)',
          background: '#fff', borderRadius: 12, padding: 20,
          boxShadow: '0 20px 50px rgba(15,23,42,0.25)',
          fontFamily: 'inherit',
        }}
      >
        <h3 style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 600, color: '#1e293b' }}>New map</h3>
        <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#475569', marginBottom: 4 }}>
          Name
        </label>
        <input
          ref={inputRef}
          data-testid="new-map-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
          placeholder="Project name"
          style={{
            width: '100%', boxSizing: 'border-box', padding: '8px 10px',
            border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 13, fontFamily: 'inherit',
            marginBottom: 14,
          }}
        />
        <div style={{ fontSize: 12, fontWeight: 600, color: '#475569', marginBottom: 6 }}>AI policy</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
          {POLICIES.map((p) => (
            <label
              key={p.value}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 8,
                padding: '8px 10px', borderRadius: 8,
                border: `1px solid ${policy === p.value ? '#3b82f6' : '#e2e8f0'}`,
                background: policy === p.value ? '#eff6ff' : '#f8fafc',
                cursor: 'pointer',
              }}
            >
              <input
                type="radio"
                name="new-map-ai-policy"
                data-testid={`new-map-ai-policy-${p.value}`}
                checked={policy === p.value}
                onChange={() => setPolicy(p.value)}
                style={{ marginTop: 2 }}
              />
              <span>
                <span style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#1e293b' }}>{p.label}</span>
                <span style={{ display: 'block', fontSize: 11, color: '#64748b' }}>{p.hint}</span>
              </span>
            </label>
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            type="button"
            onClick={onClose}
            style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid #e2e8f0', background: '#fff', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}
          >
            Cancel
          </button>
          <button
            type="submit"
            data-testid="new-map-create"
            disabled={!name.trim()}
            style={{
              padding: '6px 14px', borderRadius: 6, border: 'none',
              background: name.trim() ? '#3b82f6' : '#cbd5e1', color: '#fff',
              fontSize: 12, fontWeight: 600, cursor: name.trim() ? 'pointer' : 'default', fontFamily: 'inherit',
            }}
          >
            Create map
          </button>
        </div>
      </form>
    </div>
  );
}
