/**
 * Guided onboarding: a new project in five steps — describe it, connect
 * its repo (and import the open issues), lay out the plan, pick who does
 * the work, start. Replaces the bare "New map" dialog.
 *
 * Every step writes the map as it goes, so closing halfway leaves a real
 * project; the "Set up this project" card (ProjectSetupCard) reopens the
 * wizard at the first open step. What counts as done is core
 * `projectSetup`, the same reading the `project_setup_status` tool gives
 * an agent. The repo comes before the plan so the plan can build on the
 * imported issues. A connected fleet stays on hold (cap 0) until Start.
 *
 * GitHub / Gitea sign-in leaves the page; `rememberSetupResume` keeps the
 * map in sessionStorage so the app reopens the wizard on the way back.
 */
import { useEffect, useMemo, useState } from 'react';
import { projectSetup, type AiPolicy, type FleetWithMaps, type SetupStepId } from '@mindblown/core';
import { useMindmapStore } from './store.js';
import * as api from './api.js';
import { useAiCapabilities } from './aiCapabilities.js';
import { AIBraindumpModal } from './AIBraindumpModal.js';
import { PairMachine } from './PairMachine.js';

/** 'new' = the describe step before the map exists. */
export type SetupWizardStep = SetupStepId | 'new';

const STEPS: Array<{ id: SetupStepId; label: string }> = [
  { id: 'describe', label: 'Project' },
  { id: 'repo', label: 'Repository' },
  { id: 'plan', label: 'Plan' },
  { id: 'fleet', label: 'Who works' },
  { id: 'start', label: 'Start' },
];

const POLICIES: Array<{ value: AiPolicy; label: string; hint: string }> = [
  { value: 'any', label: 'Any provider', hint: 'Follows the server-wide AI provider. Content may reach a cloud model.' },
  { value: 'local', label: 'Local model only', hint: 'Only the self-hosted model, never the cloud. Off if none is configured.' },
  { value: 'none', label: 'No AI', hint: 'No chat, breakdown, estimates, triage or embeddings for this map.' },
];

const RESUME_KEY = 'mindblown.setupResume';

/** Before a sign-in redirect: reopen this map's setup when the user comes back. */
export function rememberSetupResume(mapId: string): void {
  try { sessionStorage.setItem(RESUME_KEY, mapId); } catch { /* storage blocked: no resume */ }
}

/** The map to resume setup on, once; null when there is none. */
export function takeSetupResume(): string | null {
  try {
    const id = sessionStorage.getItem(RESUME_KEY);
    sessionStorage.removeItem(RESUME_KEY);
    return id;
  } catch {
    return null;
  }
}

export function ProjectSetupWizard({
  step,
  onStep,
  onClose,
}: {
  step: SetupWizardStep;
  onStep: (step: SetupWizardStep) => void;
  onClose: () => void;
}) {
  const map = useMindmapStore((s) => s.currentMap);
  const nodes = useMindmapStore((s) => s.nodes);
  const setup = useMemo(() => (map ? projectSetup(map, Object.values(nodes)) : null), [map, nodes]);
  const isNew = step === 'new';
  const current: SetupStepId = isNew ? 'describe' : step;
  const index = STEPS.findIndex((s) => s.id === current);
  const next = () => onStep(STEPS[Math.min(index + 1, STEPS.length - 1)].id);

  return (
    <div
      role="dialog"
      aria-label={isNew ? 'New project' : 'Set up this project'}
      data-testid="project-setup"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(15,23,42,0.35)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 560, maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 48px)', overflow: 'auto',
          background: '#fff', borderRadius: 12, padding: 20,
          boxShadow: '0 20px 50px rgba(15,23,42,0.25)', fontFamily: 'inherit', boxSizing: 'border-box',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: '#1e293b' }}>
            {isNew ? 'New project' : `Set up ${map?.name ?? 'this project'}`}
          </h3>
          <button type="button" onClick={onClose} aria-label="Close" style={closeBtn}>&times;</button>
        </div>

        <ol style={{ display: 'flex', gap: 4, listStyle: 'none', padding: 0, margin: '0 0 16px' }}>
          {STEPS.map((s, i) => {
            const done = !!setup?.steps.find((x) => x.id === s.id)?.done;
            const active = s.id === current;
            return (
              <li key={s.id} style={{ flex: 1 }}>
                <button
                  type="button"
                  data-testid={`setup-tab-${s.id}`}
                  disabled={isNew}
                  onClick={() => onStep(s.id)}
                  style={{
                    width: '100%', padding: '6px 4px', borderRadius: 6, fontFamily: 'inherit', fontSize: 11,
                    border: `1px solid ${active ? '#3b82f6' : '#e2e8f0'}`,
                    background: active ? '#eff6ff' : '#fff',
                    color: active ? '#1d4ed8' : '#475569', fontWeight: active ? 600 : 500,
                    cursor: isNew ? 'default' : 'pointer',
                  }}
                >
                  {done && !isNew ? '✓ ' : `${i + 1}. `}{s.label}
                </button>
              </li>
            );
          })}
        </ol>

        {current === 'describe' && <DescribeStep isNew={isNew} onDone={() => onStep('repo')} />}
        {map && current === 'repo' && <RepoStep onNext={next} />}
        {map && current === 'plan' && <PlanStep onNext={next} />}
        {map && current === 'fleet' && <FleetStep onNext={next} />}
        {map && current === 'start' && setup && <StartStep onClose={onClose} />}
      </div>
    </div>
  );
}

// ── 1. Describe ──────────────────────────────────────────────────

function DescribeStep({ isNew, onDone }: { isNew: boolean; onDone: () => void }) {
  const map = useMindmapStore((s) => s.currentMap);
  const loadMap = useMindmapStore((s) => s.loadMap);
  const loadMaps = useMindmapStore((s) => s.loadMaps);
  const updateMapSettings = useMindmapStore((s) => s.updateMapSettings);
  const [name, setName] = useState(isNew ? '' : map?.name ?? '');
  // Edited as plain text; a description with markup (set over MCP) is only
  // written back when the user changed it.
  const initialDescription = isNew ? '' : stripTags(map?.description ?? '');
  const [description, setDescription] = useState(initialDescription);
  const [policy, setPolicy] = useState<AiPolicy>('any');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    setError(null);
    if (isNew) {
      try {
        const { map: created } = await api.createMap(n, { aiPolicy: policy, ...(description.trim() ? { description: description.trim() } : {}) });
        // Step on before the map opens: opening swaps the map list for the
        // editor, which mounts the wizard anew at whatever step is set.
        onDone();
        await loadMap(created.id);
        void loadMaps();
      } catch (e: any) {
        setBusy(false);
        setError(e?.message ?? 'Creating the project failed.');
      }
      return;
    }
    const changed = description !== initialDescription;
    const ok = await updateMapSettings(changed ? { name: n, description: description.trim() || null } : { name: n });
    setBusy(false);
    if (ok) onDone();
    else setError('Saving failed.');
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <label style={label}>Name</label>
      <input
        autoFocus
        data-testid="new-map-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Project name"
        style={{ ...input, marginBottom: 12 }}
      />
      <label style={label}>What is it?</label>
      <textarea
        data-testid="setup-description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="What you're building, who it's for, and what done looks like. Agents and the plan draft read this."
        rows={5}
        style={{ ...input, resize: 'vertical', marginBottom: 12 }}
      />
      {isNew && (
        <details style={{ marginBottom: 14 }}>
          <summary style={{ fontSize: 12, color: '#475569', cursor: 'pointer' }}>
            AI policy: {POLICIES.find((p) => p.value === policy)?.label}
          </summary>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
            {POLICIES.map((p) => (
              <label key={p.value} style={choice(policy === p.value)}>
                <input
                  type="radio"
                  name="new-map-ai-policy"
                  data-testid={`new-map-ai-policy-${p.value}`}
                  checked={policy === p.value}
                  onChange={() => setPolicy(p.value)}
                  style={{ marginTop: 2 }}
                />
                <span>
                  <span style={choiceTitle}>{p.label}</span>
                  <span style={choiceHint}>{p.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </details>
      )}
      {error && <div style={errorBox}>{error}</div>}
      <Footer>
        <button type="submit" data-testid="new-map-create" disabled={!name.trim() || busy} style={primary(!!name.trim() && !busy)}>
          {busy ? 'Saving…' : isNew ? 'Create and continue' : 'Save and continue'}
        </button>
      </Footer>
    </form>
  );
}

// ── 2. Repository ────────────────────────────────────────────────

interface RepoChoice {
  kind: 'github' | 'gitea';
  fullName: string;
  installationId?: string;
}

function RepoStep({ onNext }: { onNext: () => void }) {
  const map = useMindmapStore((s) => s.currentMap)!;
  const user = useMindmapStore((s) => s.user);
  const loadMap = useMindmapStore((s) => s.loadMap);
  const updateMapSettings = useMindmapStore((s) => s.updateMapSettings);
  const [gh, setGh] = useState<api.GitHubInstallStatus | null>(null);
  const [gitea, setGitea] = useState<api.GiteaAuthStatus | null>(null);
  const [repos, setRepos] = useState<RepoChoice[] | null>(null);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [imported, setImported] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState(() => repoSlug(map.name));
  const [newOwner, setNewOwner] = useState('');
  const [newPrivate, setNewPrivate] = useState(true);
  /** The repo this form created; Connect retries with it (and `addAccessUrl` says the App can't see it yet). */
  const [created, setCreated] = useState<{ choice: RepoChoice; addAccessUrl?: string } | null>(null);

  const bound = map.forgeKind && !map.forgeProblem;
  const boundName = map.githubRepoOwner && map.githubRepoName ? `${map.githubRepoOwner}/${map.githubRepoName}` : null;

  useEffect(() => {
    if (bound) return;
    let alive = true;
    (async () => {
      const [ghStatus, giteaStatus] = await Promise.all([
        api.getGitHubInstallStatus().catch(() => null),
        api.getGiteaAuthStatus(map.workspaceId).catch(() => null),
      ]);
      if (!alive) return;
      setGh(ghStatus);
      setGitea(giteaStatus);
      const list: RepoChoice[] = [];
      for (const inst of ghStatus?.connected ? ghStatus.installations : []) {
        const r = await api.getGitHubRepositories(inst.installationId).catch(() => null);
        for (const repo of r?.repositories ?? []) list.push({ kind: 'github', fullName: repo.fullName, installationId: inst.installationId });
      }
      if (giteaStatus?.configured && giteaStatus.connected) {
        const r = await api.getGiteaRepositories().catch(() => null);
        for (const repo of r?.repositories ?? []) list.push({ kind: 'gitea', fullName: repo.fullName });
      }
      if (alive) setRepos(list);
    })();
    return () => { alive = false; };
  }, [bound, map.workspaceId]);

  const signIn = async (forge: 'github' | 'gitea') => {
    setError(null);
    try {
      const url = forge === 'github' ? (await api.getGitHubInstallUrl()).installUrl : (await api.getGiteaAuthorizeUrl()).authorizeUrl;
      rememberSetupResume(map.id);
      window.location.href = url;
    } catch (e: any) {
      setError(e?.message ?? 'Could not start the sign-in.');
    }
  };

  const connect = async () => {
    const choice = repos?.find((r) => `${r.kind}:${r.fullName}` === selected);
    if (choice) await connectChoice(choice);
  };

  const connectChoice = async (choice: RepoChoice) => {
    if (!user) return;
    const [owner, name] = choice.fullName.split('/');
    setError(null);
    setBusy('Connecting…');
    try {
      if (choice.kind === 'github') {
        const ok = await updateMapSettings({
          githubInstallationId: choice.installationId ?? null,
          githubRepoOwner: owner,
          githubRepoName: name,
          autoImportNewIssues: true,
        });
        if (!ok) throw new Error(useMindmapStore.getState().error ?? 'Connecting the repository failed.');
      } else {
        await api.bindGiteaRepo(map.workspaceId, owner, name, undefined, map.id);
        await updateMapSettings({ autoImportNewIssues: true });
      }
      setBusy('Importing open issues…');
      const result = await api.importGitHubIssues(map.id, user.id);
      setImported(result.imported);
    } catch (e: any) {
      setError(e?.message ?? 'Connecting the repository failed.');
    } finally {
      setBusy(null);
      await loadMap(map.id);
    }
  };

  const createRepo = async (owner: string) => {
    setError(null);
    setBusy('Creating the repository…');
    const description = Array.from(plainText(map.description ?? '')).slice(0, 350).join('') || undefined;
    try {
      let choice: RepoChoice;
      if (owner === 'gitea') {
        const r = await api.createGiteaRepository({ name: newName.trim(), private: newPrivate, description });
        choice = { kind: 'gitea', fullName: r.fullName };
        setCreated({ choice });
      } else {
        const installationId = owner.slice('github:'.length);
        const r = await api.createGitHubRepository({ installationId, name: newName.trim(), private: newPrivate, description });
        choice = { kind: 'github', fullName: r.fullName, installationId };
        setCreated({ choice, ...(r.reachable ? {} : { addAccessUrl: r.addAccessUrl }) });
        if (!r.reachable) {
          setBusy(null);
          return;
        }
      }
      await connectChoice(choice);
    } catch (e: any) {
      setError(e?.message ?? 'Creating the repository failed.');
      setBusy(null);
    }
  };

  if (bound) {
    return (
      <>
        <p style={text} data-testid="setup-repo-bound">
          Connected to <strong>{boundName ?? 'its repository'}</strong>.
          {imported !== null && (imported === 0
            ? ' No open issues yet; new ones come in by themselves.'
            : ` Imported ${imported} open issue${imported === 1 ? '' : 's'}; new ones come in by themselves.`)}
        </p>
        {error && <div style={errorBox}>{error} New issues still come in by themselves; the import can be rerun in the map&apos;s forge settings.</div>}
        <Footer><button type="button" onClick={onNext} style={primary(true)}>Continue</button></Footer>
      </>
    );
  }

  const ghReady = !!gh?.connected && gh.installations.length > 0;
  const giteaReady = !!gitea?.configured && gitea.connected;
  const nothingConfigured = gh !== null && !gh.appConfigured && !gitea?.configured;
  // Where a new repo can go: the user's own account and orgs among their
  // App installations, and their Gitea account.
  const owners: Array<{ value: string; label: string }> = [
    ...(ghReady ? gh!.installations : [])
      .filter((i) => i.accountType === 'Organization' || i.accountLogin.toLowerCase() === gh!.identity?.githubLogin.toLowerCase())
      .map((i) => ({ value: `github:${i.installationId}`, label: `${i.accountLogin}${giteaReady ? ' (GitHub)' : ''}` })),
    ...(giteaReady && gitea!.identity ? [{ value: 'gitea', label: `${gitea!.identity.login}${ghReady ? ' (Gitea)' : ''}` }] : []),
  ];
  const owner = newOwner || owners[0]?.value || '';
  const nameOk = /^[A-Za-z0-9._-]{1,100}$/.test(newName.trim());

  return (
    <>
      <p style={text}>
        Where does the code live? Agents work in this repository, and its open issues become the start of the plan.
      </p>
      {map.forgeProblem && <div style={errorBox}>{map.forgeProblem.message}</div>}

      {(ghReady || giteaReady) && (
        <>
          <label style={label}>Repository</label>
          <select
            data-testid="setup-repo-select"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            disabled={repos === null || !!busy}
            style={{ ...input, marginBottom: 6 }}
          >
            <option value="">{repos === null ? 'Loading repositories…' : 'Pick a repository'}</option>
            {(repos ?? []).map((r) => (
              <option key={`${r.kind}:${r.fullName}`} value={`${r.kind}:${r.fullName}`}>
                {r.fullName}{ghReady && giteaReady ? ` (${r.kind === 'github' ? 'GitHub' : 'Gitea'})` : ''}
              </option>
            ))}
          </select>
          <div style={{ ...hint, marginBottom: 12 }}>
            Connecting imports every open issue and keeps new ones coming in.
            {ghReady && (
              <> Not listed? <button type="button" onClick={() => signIn('github')} style={linkBtn}>Give the GitHub App access to it</button>.</>
            )}
          </div>
        </>
      )}

      {owners.length > 0 && !creating && (
        <div style={{ marginBottom: 12 }}>
          <button type="button" data-testid="setup-repo-new" onClick={() => setCreating(true)} disabled={!!busy} style={secondary}>
            Create a new repository
          </button>
        </div>
      )}
      {creating && (
        <div data-testid="setup-repo-create" style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <div style={{ flex: '0 0 40%' }}>
              <label style={label}>Owner</label>
              <select data-testid="setup-repo-new-owner" value={owner} onChange={(e) => setNewOwner(e.target.value)} disabled={!!busy || !!created} style={input}>
                {owners.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label style={label}>Name</label>
              <input data-testid="setup-repo-new-name" value={newName} onChange={(e) => setNewName(e.target.value)} disabled={!!busy || !!created} style={input} />
            </div>
          </div>
          <label style={{ ...hint, display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
            <input type="checkbox" data-testid="setup-repo-new-private" checked={newPrivate} onChange={(e) => setNewPrivate(e.target.checked)} disabled={!!busy || !!created} />
            Private
          </label>
          <div style={{ ...hint, marginBottom: 8 }}>
            Starts with a README so agents have a main branch to work from. The project description becomes the repository description.
          </div>
          {created && (
            <div style={{ ...hint, marginBottom: 8 }} data-testid="setup-repo-created">
              Created <strong>{created.choice.fullName}</strong>.
              {created.addAccessUrl && (
                <> The GitHub App only sees selected repositories:{' '}
                  <a href={created.addAccessUrl} target="_blank" rel="noreferrer">add it to the App</a>, then press Connect.</>
              )}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" onClick={() => { setCreating(false); setCreated(null); }} disabled={!!busy} style={secondary}>Cancel</button>
            {created ? (
              <button type="button" data-testid="setup-repo-created-connect" onClick={() => connectChoice(created.choice)} disabled={!!busy} style={primary(!busy)}>Connect</button>
            ) : (
              <button
                type="button"
                data-testid="setup-repo-new-create"
                onClick={() => createRepo(owner)}
                disabled={!nameOk || !owner || !!busy}
                style={primary(nameOk && !!owner && !busy)}
              >
                Create and connect
              </button>
            )}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        {gh?.appConfigured && !ghReady && (
          <button type="button" data-testid="setup-github-connect" onClick={() => signIn('github')} style={secondary}>Connect GitHub</button>
        )}
        {gitea?.configured && !gitea.connected && (
          <button type="button" onClick={() => signIn('gitea')} style={secondary}>Sign in with Gitea</button>
        )}
      </div>
      {nothingConfigured && (
        <div style={{ ...hint, marginBottom: 12 }}>
          This server has no GitHub App or Gitea sign-in set up. You can connect a repository with a token later in the map&apos;s forge settings.
        </div>
      )}

      {busy && <div style={{ ...hint, marginBottom: 8 }}>{busy}</div>}
      {error && <div style={errorBox}>{error}</div>}
      <Footer>
        <button type="button" data-testid="setup-repo-skip" onClick={onNext} disabled={!!busy} style={secondary}>No repository yet</button>
        {(ghReady || giteaReady) && (
          <button type="button" data-testid="setup-repo-connect" onClick={connect} disabled={!selected || !!busy} style={primary(!!selected && !busy)}>
            Connect and import issues
          </button>
        )}
      </Footer>
    </>
  );
}

/** A repository name from the project name: "Bakery Shop" → "bakery-shop". */
function repoSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'project';
}

// ── 3. Plan ──────────────────────────────────────────────────────

function PlanStep({ onNext }: { onNext: () => void }) {
  const map = useMindmapStore((s) => s.currentMap)!;
  const nodes = useMindmapStore((s) => s.nodes);
  const rootNodeId = useMindmapStore((s) => s.rootNodeId);
  const loadMap = useMindmapStore((s) => s.loadMap);
  const ai = useAiCapabilities(map.id);
  const [drafting, setDrafting] = useState(false);
  const [lines, setLines] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const all = Object.values(nodes).filter((n) => n.parentId !== null);
  const topLevel = all.filter((n) => n.parentId === rootNodeId);
  const imported = all.filter((n) => (n.externalLinks ?? []).length > 0).length;
  const description = plainText(map.description ?? '');

  // One at a time: parallel creates race on the root's child order.
  const addLines = async () => {
    if (!rootNodeId || adding) return;
    setAdding(true);
    setError(null);
    try {
      for (const line of lines.split('\n').map((l) => l.replace(/^[-*\d.)\s]+/, '').trim()).filter(Boolean)) {
        await api.createNode(map.id, rootNodeId, line);
      }
      setLines('');
    } catch (e: any) {
      setError(e?.message ?? 'Adding failed.');
    } finally {
      await loadMap(map.id);
      setAdding(false);
    }
  };

  return (
    <>
      <p style={text} data-testid="setup-plan-summary">
        {all.length === 0
          ? 'The map is empty. Lay out the main areas of work; the tree is organized by what, not when.'
          : `The plan has ${all.length} node${all.length === 1 ? '' : 's'}, ${topLevel.length} at the top${imported > 0 ? `, ${imported} from imported issues` : ''}.`}
      </p>

      {ai.structured && rootNodeId && (
        <div style={{ marginBottom: 14 }}>
          <button type="button" data-testid="setup-plan-draft" onClick={() => setDrafting(true)} style={secondary}>
            Draft the plan with AI
          </button>
          <div style={{ ...hint, marginTop: 4 }}>
            Starts from your description; you review and edit the tree before anything is added.
            {imported > 0 && ' Imported issues are left as they are.'}
          </div>
        </div>
      )}

      <label style={label}>{ai.structured ? 'Or type the main areas, one per line' : 'The main areas, one per line'}</label>
      <textarea
        data-testid="setup-plan-lines"
        value={lines}
        onChange={(e) => setLines(e.target.value)}
        rows={4}
        placeholder={'Sign-up and login\nCheckout\nAdmin dashboard'}
        style={{ ...input, resize: 'vertical', marginBottom: 6 }}
      />
      <div style={{ marginBottom: 12 }}>
        <button type="button" data-testid="setup-plan-add" onClick={addLines} disabled={!lines.trim() || adding} style={secondary}>
          {adding ? 'Adding…' : 'Add to the map'}
        </button>
      </div>
      {error && <div style={errorBox}>{error}</div>}

      <Footer>
        <button type="button" onClick={onNext} style={primary(true)}>{all.length === 0 ? 'Skip for now' : 'Continue'}</button>
      </Footer>

      {drafting && rootNodeId && (
        <AIBraindumpModal
          mapId={map.id}
          parentId={rootNodeId}
          parentText={nodes[rootNodeId]?.text ?? map.name}
          initialProse={description}
          askFirst
          onClose={() => setDrafting(false)}
        />
      )}
    </>
  );
}

// ── 4. Who works ─────────────────────────────────────────────────

const NO_FLEET = '__none__';
const PAIR = '__pair__';

function FleetStep({ onNext }: { onNext: () => void }) {
  const map = useMindmapStore((s) => s.currentMap)!;
  const loadMap = useMindmapStore((s) => s.loadMap);
  const updateMapSettings = useMindmapStore((s) => s.updateMapSettings);
  const [fleets, setFleets] = useState<FleetWithMaps[] | null>(null);
  const [choice, setChoice] = useState<string>(map.fleetId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.listFleets().then((all) => { if (alive) setFleets(all.filter((f) => f.isOwner)); }).catch(() => { if (alive) setFleets([]); });
    return () => { alive = false; };
  }, []);

  // Connected but on hold: the fleet takes nothing until the Start step.
  const connect = async (fleetId: string) => {
    setBusy(true);
    setError(null);
    const ok = await updateMapSettings({ fleetId, maxActiveClaims: 0 });
    // The PUT reply has no fleetName (derived on GET); reload for the summary.
    if (ok) await loadMap(map.id);
    setBusy(false);
    if (ok) onNext();
    else setError('Connecting the fleet failed. Connecting needs admin on the map.');
  };

  const apply = async () => {
    if (choice === NO_FLEET) {
      if (map.fleetId) {
        setBusy(true);
        const ok = await updateMapSettings({ fleetId: null });
        setBusy(false);
        if (!ok) { setError('Disconnecting the fleet failed.'); return; }
      }
      onNext();
    } else if (choice && choice !== PAIR) {
      if (choice === map.fleetId) onNext();
      else await connect(choice);
    }
  };

  // Default: the fleet already connected, else the only fleet there is.
  useEffect(() => {
    if (choice || !fleets) return;
    setChoice(fleets.length === 1 ? fleets[0].id : fleets.length === 0 ? PAIR : '');
  }, [fleets, choice]);

  const origin = window.location.origin;

  return (
    <>
      <p style={text}>
        Who does the work? A fleet is one or more machines whose agents take tickets from your projects, open pull requests and follow them to the merge.
      </p>
      {fleets === null ? (
        <div style={hint}>Loading fleets…</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
          {fleets.map((f) => (
            <label key={f.id} style={choice === f.id ? choiceOn : choiceOff}>
              <input type="radio" name="setup-fleet" data-testid={`setup-fleet-${f.id}`} checked={choice === f.id} onChange={() => setChoice(f.id)} style={{ marginTop: 2 }} />
              <span>
                <span style={choiceTitle}>{f.name}</span>
                <span style={choiceHint}>
                  {f.maps.length === 0 ? 'No projects yet' : `Works on ${f.maps.map((m) => m.name).join(', ')}`}
                </span>
              </span>
            </label>
          ))}
          <label style={choice === PAIR ? choiceOn : choiceOff}>
            <input type="radio" name="setup-fleet" data-testid="setup-fleet-pair" checked={choice === PAIR} onChange={() => setChoice(PAIR)} style={{ marginTop: 2 }} />
            <span>
              <span style={choiceTitle}>Pair a new machine</span>
              <span style={choiceHint}>Install the fleet worker on a machine; it becomes a new fleet working on this project.</span>
            </span>
          </label>
          <label style={choice === NO_FLEET ? choiceOn : choiceOff}>
            <input type="radio" name="setup-fleet" data-testid="setup-fleet-none" checked={choice === NO_FLEET} onChange={() => setChoice(NO_FLEET)} style={{ marginTop: 2 }} />
            <span>
              <span style={choiceTitle}>People only</span>
              <span style={choiceHint}>No agents. You can connect a fleet later in the map&apos;s settings.</span>
            </span>
          </label>
        </div>
      )}

      {choice === PAIR && (
        <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <div style={{ ...hint, marginBottom: 6 }}>On the machine that will run the agents, from the claude-fleet repository:</div>
          <pre style={pre}>{`./worker/install.sh\nfleet-worker pair --server ${origin} --agent claude-code --slots 1`}</pre>
          <PairMachine onPaired={(p) => connect(p.fleetId)} />
        </div>
      )}

      {choice && choice !== PAIR && choice !== NO_FLEET && (
        <div style={{ ...hint, marginBottom: 12 }}>
          The fleet stays on hold until you press Start. Tickets you file merge by themselves once CI is green; tickets from others stop at the pull request (the map&apos;s trust settings).
        </div>
      )}
      {error && <div style={errorBox}>{error}</div>}
      <Footer>
        {choice !== PAIR && (
          <button type="button" data-testid="setup-fleet-apply" onClick={apply} disabled={!choice || busy} style={primary(!!choice && !busy)}>
            {busy ? 'Saving…' : choice === NO_FLEET || choice === map.fleetId ? 'Continue' : 'Connect and continue'}
          </button>
        )}
      </Footer>
    </>
  );
}

// ── 5. Start ─────────────────────────────────────────────────────

function StartStep({ onClose }: { onClose: () => void }) {
  const map = useMindmapStore((s) => s.currentMap)!;
  const nodes = useMindmapStore((s) => s.nodes);
  const updateMapSettings = useMindmapStore((s) => s.updateMapSettings);
  const setup = projectSetup(map, Object.values(nodes));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const held = !!map.fleetId && map.maxActiveClaims === 0;

  const finish = async (start: boolean) => {
    setBusy(true);
    setError(null);
    const ok = await updateMapSettings(start ? { maxActiveClaims: 1, setupCompleted: true } : { setupCompleted: true });
    setBusy(false);
    if (ok) onClose();
    else setError('Saving failed.');
  };

  return (
    <>
      <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 14px' }} data-testid="setup-summary">
        {setup.steps.filter((s) => s.id !== 'start').map((s) => (
          <li key={s.id} style={{ display: 'flex', gap: 8, padding: '6px 0', borderBottom: '1px solid #f1f5f9' }}>
            <span style={{ color: s.done ? '#16a34a' : '#94a3b8', fontWeight: 700, width: 14 }}>{s.done ? '✓' : '○'}</span>
            <span>
              <span style={choiceTitle}>{s.label}</span>
              <span style={choiceHint}>{s.detail}</span>
            </span>
          </li>
        ))}
      </ul>
      <p style={text}>
        {held
          ? 'Start lets the fleet take one ticket at a time from this project. You can raise that later in the Fleet tab.'
          : map.fleetId
            ? setup.steps.find((s) => s.id === 'start')!.detail
            : 'People do the work here. Finish closes this checklist; the plan is ready to use.'}
      </p>
      {error && <div style={errorBox}>{error}</div>}
      <Footer>
        {held && (
          <button type="button" data-testid="setup-finish-hold" onClick={() => finish(false)} disabled={busy} style={secondary}>Keep on hold</button>
        )}
        <button type="button" data-testid="setup-finish" onClick={() => finish(held)} disabled={busy} style={primary(!busy)}>
          {held ? 'Start' : 'Finish'}
        </button>
      </Footer>
    </>
  );
}

// ── Bits ─────────────────────────────────────────────────────────

function Footer({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>{children}</div>;
}

/** Rich-text HTML as one line of text: blocks become spaces, entities decoded. */
function plainText(html: string): string {
  const spaced = html.replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|blockquote|pre)>/gi, ' ');
  return (new DOMParser().parseFromString(spaced, 'text/html').body.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, '').trim();
}

const closeBtn: React.CSSProperties = { background: 'none', border: 'none', fontSize: 20, color: '#94a3b8', cursor: 'pointer', padding: '0 4px' };
const label: React.CSSProperties = { display: 'block', fontSize: 12, fontWeight: 600, color: '#475569', marginBottom: 4 };
const input: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '8px 10px',
  border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 13, fontFamily: 'inherit',
};
const text: React.CSSProperties = { fontSize: 13, color: '#334155', margin: '0 0 12px', lineHeight: 1.5 };
const hint: React.CSSProperties = { fontSize: 11, color: '#64748b', lineHeight: 1.5 };
const errorBox: React.CSSProperties = { fontSize: 12, color: '#b91c1c', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, padding: '6px 10px', marginBottom: 10 };
const pre: React.CSSProperties = { fontSize: 11, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 6, padding: 8, margin: '0 0 10px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' };
const linkBtn: React.CSSProperties = { background: 'none', border: 'none', padding: 0, color: '#2563eb', cursor: 'pointer', fontSize: 11, fontFamily: 'inherit', textDecoration: 'underline' };
const secondary: React.CSSProperties = { padding: '6px 12px', borderRadius: 6, border: '1px solid #e2e8f0', background: '#fff', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', color: '#1e293b' };
const primary = (enabled: boolean): React.CSSProperties => ({
  padding: '6px 14px', borderRadius: 6, border: 'none',
  background: enabled ? '#3b82f6' : '#cbd5e1', color: '#fff',
  fontSize: 12, fontWeight: 600, cursor: enabled ? 'pointer' : 'default', fontFamily: 'inherit',
});
const choice = (on: boolean): React.CSSProperties => ({
  display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 10px', borderRadius: 8,
  border: `1px solid ${on ? '#3b82f6' : '#e2e8f0'}`, background: on ? '#eff6ff' : '#f8fafc', cursor: 'pointer',
});
const choiceOn = choice(true);
const choiceOff = choice(false);
const choiceTitle: React.CSSProperties = { display: 'block', fontSize: 12, fontWeight: 600, color: '#1e293b' };
const choiceHint: React.CSSProperties = { display: 'block', fontSize: 11, color: '#64748b' };
