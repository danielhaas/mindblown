/**
 * Pair a machine (#506): the worker on the machine shows a code, the
 * owner types it here, checks which machine it is, and pairs it — as a
 * new fleet named after the host (map settings / Fleet tab), or into a
 * fleet they own (fleet page; the machine's key joins the fleet's keys,
 * or for a reinstall replaces them). The machine collects its key by
 * itself a few seconds later.
 *
 * The server decides (services/fleetPairing.ts): a signed-in person only,
 * a code works once and for 10 minutes, wrong codes are limited.
 */
import { useState } from 'react';
import * as api from './api.js';

export interface Paired {
  fleetId: string;
  fleetName: string;
  created: boolean;
}

export function PairMachine({
  fleetId,
  beforeConfirm,
  onPaired,
}: {
  /** Pair into this fleet (re-pair); omitted = a new fleet. */
  fleetId?: string;
  /** Last chance to back out (e.g. leaving a fleet with live claims); false = cancel. */
  beforeConfirm?: (fleetName: string) => boolean;
  onPaired: (p: Paired) => void | Promise<void>;
}) {
  const [code, setCode] = useState('');
  const [machine, setMachine] = useState<api.PairingMachine | null>(null);
  const [name, setName] = useState('');
  const [replaceKeys, setReplaceKeys] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lookup = async () => {
    if (busy || !code.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const m = await api.lookupPairing(code);
      setMachine(m);
      setName(m.hostname);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Looking up the code failed');
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (busy || !machine) return;
    if (beforeConfirm && !beforeConfirm(name.trim() || machine.hostname)) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.confirmPairing(code, fleetId ? { fleetId, replaceKeys } : { name: name.trim() || machine.hostname });
      await onPaired({ fleetId: r.fleetId, fleetName: r.fleetName, created: r.created });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Pairing failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={box} data-testid="pair-machine">
      <div style={{ fontSize: 12, color: '#64748b', marginBottom: 8 }}>
        On the machine, run <code>fleet-worker pair</code>. Type the code it shows.
      </div>
      {!machine ? (
        <div style={row}>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void lookup()}
            placeholder="ABCD-EFGH"
            maxLength={20}
            autoFocus
            style={{ ...input, width: 120, fontFamily: 'ui-monospace, monospace', textTransform: 'uppercase' }}
            aria-label="Pairing code"
            data-testid="pair-code"
          />
          <button style={btn} disabled={busy || !code.trim()} onClick={() => void lookup()} data-testid="pair-lookup">
            {busy ? 'Checking…' : 'Check code'}
          </button>
        </div>
      ) : (
        <>
          <div style={{ fontSize: 13, color: '#334155', marginBottom: 8 }} data-testid="pair-machine-info">
            <strong>{machine.hostname}</strong>
            <span style={{ color: '#64748b' }}>
              {' '}· {machine.agent ?? 'agent not reported'}
              {machine.model && ` (${machine.model})`} · {machine.slots} slot{machine.slots === 1 ? '' : 's'}
            </span>
          </div>
          {fleetId && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#334155', marginBottom: 8 }}>
              <input type="checkbox" checked={replaceKeys} onChange={(e) => setReplaceKeys(e.target.checked)} data-testid="pair-replace-keys" />
              Reinstall: revoke the fleet&apos;s other keys once this machine has its key
            </label>
          )}
          <div style={row}>
            {!fleetId && (
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void confirm()}
                maxLength={200}
                placeholder="Fleet name"
                aria-label="Fleet name"
                style={{ ...input, flex: 1, minWidth: 120 }}
                data-testid="pair-fleet-name"
              />
            )}
            <button style={{ ...btn, ...btnPrimary }} disabled={busy} onClick={() => void confirm()} data-testid="pair-confirm">
              {busy ? 'Pairing…' : fleetId ? 'Pair into this fleet' : 'Pair as new fleet'}
            </button>
            <button style={btn} disabled={busy} onClick={() => { setMachine(null); setError(null); }}>
              Not this machine
            </button>
          </div>
        </>
      )}
      {error && <div style={warnBox}>{error}</div>}
    </div>
  );
}

const box: React.CSSProperties = { background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: '10px 12px', marginTop: 8 };
const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' };
const input: React.CSSProperties = { fontSize: 12, padding: '3px 6px', border: '1px solid #cbd5e1', borderRadius: 6, fontFamily: 'inherit', background: '#fff' };
const btn: React.CSSProperties = { fontSize: 12, padding: '3px 10px', border: '1px solid #cbd5e1', borderRadius: 6, background: '#fff', color: '#334155', cursor: 'pointer', fontFamily: 'inherit' };
const btnPrimary: React.CSSProperties = { background: '#4f46e5', border: '1px solid #4f46e5', color: '#fff' };
const warnBox: React.CSSProperties = { background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', borderRadius: 8, padding: '6px 10px', fontSize: 12, marginTop: 8 };
