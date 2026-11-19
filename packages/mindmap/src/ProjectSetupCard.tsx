/**
 * "Set up this project" card on a new map (guided onboarding): the setup
 * checklist (core projectSetup) until the owner finishes the wizard or
 * dismisses the card. Shown only to the map's creator, who owns the setup,
 * and only while `setupCompletedAt` is null — maps from before the
 * checklist were stamped by the migration.
 */
import { useMemo } from 'react';
import { projectSetup, type SetupStepId } from '@mindblown/core';
import { useMindmapStore } from './store.js';

export function ProjectSetupCard({ onContinue }: { onContinue: (step: SetupStepId) => void }) {
  const map = useMindmapStore((s) => s.currentMap);
  const user = useMindmapStore((s) => s.user);
  const nodes = useMindmapStore((s) => s.nodes);
  const updateMapSettings = useMindmapStore((s) => s.updateMapSettings);
  const setup = useMemo(() => (map ? projectSetup(map, Object.values(nodes)) : null), [map, nodes]);
  if (!map || !setup || map.setupCompletedAt !== null || map.archivedAt || map.createdBy !== user?.id) return null;

  const done = setup.steps.filter((s) => s.done).length;
  return (
    <div
      data-testid="project-setup-card"
      style={{
        position: 'fixed', left: 16, top: 64, zIndex: 50, width: 260,
        background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: 12,
        boxShadow: '0 8px 24px rgba(15,23,42,0.12)', fontSize: 12,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
        <strong style={{ color: '#1e293b', fontSize: 13 }}>Set up this project</strong>
        <span style={{ color: '#64748b' }}>{done} of {setup.steps.length}</span>
      </div>
      <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 10px' }}>
        {setup.steps.map((s) => (
          <li key={s.id} style={{ display: 'flex', gap: 6, padding: '2px 0', color: s.done ? '#64748b' : '#1e293b' }}>
            <span style={{ color: s.done ? '#16a34a' : '#94a3b8', width: 12 }}>{s.done ? '✓' : '○'}</span>
            <span style={{ textDecoration: s.done ? 'line-through' : 'none' }}>{s.label}</span>
          </li>
        ))}
      </ul>
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <button
          type="button"
          data-testid="project-setup-dismiss"
          onClick={() => void updateMapSettings({ setupCompleted: true })}
          style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid #e2e8f0', background: '#fff', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}
        >
          Dismiss
        </button>
        <button
          type="button"
          data-testid="project-setup-continue"
          onClick={() => onContinue(setup.next?.id ?? 'start')}
          style={{ padding: '4px 12px', borderRadius: 6, border: 'none', background: '#3b82f6', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
        >
          Continue
        </button>
      </div>
    </div>
  );
}
