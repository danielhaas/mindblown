/**
 * create_forge_repo: map admin is checked before anything is created; the
 * GitHub path finds the installation by owner, creates, and connects the
 * map through PUT /api/maps/:id; a repo the App can't see yet, or a connect
 * that fails, is reported as created-but-not-connected so the agent does
 * not create it twice; the Gitea path creates and binds.
 */

import { describe, it, expect, vi } from 'vitest';
import { createMindblownMcpServer, runWithApiContext } from '../index.js';

interface Registered {
  handler: (args: unknown, extra: unknown) => Promise<{ content: Array<{ text: string }> }>;
}

const tool = () =>
  (createMindblownMcpServer() as unknown as { _registeredTools: Record<string, Registered> })._registeredTools.create_forge_repo;

type Call = { method: string; url: string; payload?: unknown };
type Route = (call: Call) => { status: number; body: unknown } | undefined;

const STATUS = {
  connected: true,
  identity: { githubLogin: 'alice' },
  installations: [
    { installationId: '111', accountLogin: 'alice', accountType: 'User' },
    { installationId: '222', accountLogin: 'acme', accountType: 'Organization' },
  ],
  appConfigured: true,
};

async function run(args: Record<string, unknown>, routes: Route) {
  const calls: Call[] = [];
  const injector = vi.fn(async (call: { method?: string; url: string; payload?: unknown }) => {
    const c = { method: call.method ?? 'GET', url: call.url, payload: call.payload };
    calls.push(c);
    const hit = routes(c) ?? { status: 404, body: { error: { code: 'NOT_FOUND', message: `${c.method} ${c.url}` } } };
    return { statusCode: hit.status, body: JSON.stringify(hit.body), headers: { 'content-type': 'application/json' } };
  });
  const res = await runWithApiContext({ baseUrl: 'http://unused.invalid', token: 'mb_test', injector }, () =>
    tool().handler({ mapId: 'm1', ...args }, {}),
  );
  return { text: res.content[0].text, calls };
}

const created = (owner: string, name: string, extra: Record<string, unknown> = {}) => ({
  status: 201,
  body: { fullName: `${owner}/${name}`, owner, name, private: true, htmlUrl: `https://github.com/${owner}/${name}`, ...extra },
});

const base: Route = (c) => {
  if (c.url === '/api/maps/m1/permissions') return { status: 200, body: { permissions: [], pendingInvites: [] } };
  if (c.url === '/api/auth/github/status') return { status: 200, body: STATUS };
  return undefined;
};

describe('create_forge_repo', () => {
  it('creates nothing for a caller who is not map admin', async () => {
    const { text, calls } = await run({ name: 'shop' }, (c) =>
      c.url === '/api/maps/m1/permissions' ? { status: 403, body: { error: { code: 'FORBIDDEN', message: 'no' } } } : undefined,
    );
    expect(text).toMatch(/^Not created/);
    expect(calls.map((c) => c.url)).toEqual(['/api/maps/m1/permissions']);
  });

  it('creates in the named org and connects the map', async () => {
    const { text, calls } = await run({ name: 'shop', owner: 'ACME' }, (c) => {
      if (c.method === 'POST' && c.url === '/api/integrations/github/repositories') return created('acme', 'shop', { installationId: '222', reachable: true });
      if (c.method === 'PUT' && c.url === '/api/maps/m1') return { status: 200, body: { id: 'm1' } };
      return base(c);
    });
    expect(text).toMatch(/^Created GitHub repo acme\/shop .* and connected it to map m1/);
    const create = calls.find((c) => c.method === 'POST' && c.url === '/api/integrations/github/repositories')!;
    expect(JSON.parse(create.payload as string)).toEqual({ installationId: '222', name: 'shop', private: true });
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(JSON.parse(put.payload as string)).toEqual({ githubInstallationId: '222', githubRepoOwner: 'acme', githubRepoName: 'shop', autoImportNewIssues: true });
  });

  it("reports a repo the App can't see yet as created, not connected", async () => {
    const { text, calls } = await run({ name: 'shop' }, (c) => {
      if (c.method === 'POST' && c.url === '/api/integrations/github/repositories') {
        return created('alice', 'shop', { installationId: '111', reachable: false, addAccessUrl: 'https://github.com/settings/installations/111' });
      }
      return base(c);
    });
    expect(text).toContain('NOT connected yet');
    expect(text).toContain('https://github.com/settings/installations/111');
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('says the repo exists when connecting fails afterwards', async () => {
    const { text } = await run({ name: 'shop' }, (c) => {
      if (c.method === 'POST' && c.url === '/api/integrations/github/repositories') return created('alice', 'shop', { installationId: '111', reachable: true });
      if (c.method === 'PUT') return { status: 502, body: { error: { code: 'GITHUB_ERROR', message: 'GitHub did not answer' } } };
      return base(c);
    });
    expect(text).toMatch(/Created alice\/shop .* could NOT connect it .*Do not create it again/);
  });

  it('names the installed accounts for an owner without the App', async () => {
    const { text } = await run({ name: 'shop', owner: 'other-org' }, base);
    expect(text).toContain('not installed on other-org. Installed on: alice, acme.');
  });

  it('Gitea: creates in the user account, binds it to the map', async () => {
    const { text, calls } = await run({ name: 'shop', kind: 'gitea' }, (c) => {
      if (c.url === '/api/maps/m1' && c.method === 'GET') return { status: 200, body: { map: { id: 'm1', workspaceId: 'ws1' }, nodes: [] } };
      if (c.method === 'POST' && c.url === '/api/integrations/gitea/repositories') return created('alice', 'shop');
      if (c.method === 'POST' && c.url === '/api/integrations/gitea/bind') return { status: 201, body: { id: 'i1', repo: 'alice/shop' } };
      if (c.method === 'PUT' && c.url === '/api/maps/m1') return { status: 200, body: { id: 'm1' } };
      return base(c);
    });
    expect(text).toMatch(/^Created Gitea repo alice\/shop/);
    const bind = calls.find((c) => c.url === '/api/integrations/gitea/bind')!;
    expect(JSON.parse(bind.payload as string)).toEqual({ workspaceId: 'ws1', owner: 'alice', repo: 'shop', mapId: 'm1' });
  });
});
