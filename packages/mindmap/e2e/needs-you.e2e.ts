/**
 * #610 in a browser: a Kanban card's detail view shows what the ticket
 * waits on, with the action, at desktop and at phone width (390 px). The
 * harness renders the real board + detail components; this file plays the
 * server (REST through page.route, the socket through routeWebSocket).
 */
import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import { ALL_NODES, APPROVE, ASK, BLOCKED, MAP_ID, PENDING, WORKFLOW } from '../src/__tests__/needsYouFixtures.js';

const MAP = {
  id: MAP_ID,
  workspaceId: 'w1',
  name: 'Project',
  description: null,
  rootNodeId: 'root',
  effortUnit: 'days',
  statusWorkflow: WORKFLOW,
  customFieldDefs: [],
  defaultLayout: 'tree',
  healthThreshold: 0.2,
  phases: [],
  baselines: [],
  wipLimit: null,
  fleetId: null,
  computedProgress: 0,
  healthSignal: 'on_track',
};
const withComputed = <T extends object>(n: T) => ({ ...n, computedEffort: 0, computedProgress: 0, healthSignal: 'on_track', actualEffort: null });

interface Server {
  calls: { method: string; path: string; body: unknown }[];
  socket: () => WebSocketRoute | null;
}

/** Answers the harness's API calls; every decision clears what it decided, like the server. */
async function serve(page: Page): Promise<Server> {
  const nodes = new Map(ALL_NODES.map((n) => [n.id, withComputed(n)]));
  let approvals = [PENDING];
  let asks = [ASK];
  const calls: Server['calls'] = [];
  let socket: WebSocketRoute | null = null;
  await page.routeWebSocket(/\/ws\//, (ws) => {
    socket = ws;
  });
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const body = req.postData() ? JSON.parse(req.postData()!) : null;
    calls.push({ method: req.method(), path, body });
    const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    const base = `/api/maps/${MAP_ID}`;
    if (path === base) return json({ map: MAP, nodes: [...nodes.values()] });
    if (path === `${base}/approvals`) return json({ items: approvals, now: new Date().toISOString() });
    if (path === `${base}/asks`) return json({ items: asks, counts: {}, pushedAt: ASK.pushedAt, meta: null, now: new Date().toISOString() });
    if (path === `${base}/nodes/approve/approve` && req.method() === 'POST') {
      approvals = [];
      const approved = { ...nodes.get('approve')!, approval: { state: 'approved', merge: body.merge, by: 'u1', at: new Date().toISOString() } };
      nodes.set('approve', approved);
      return json({ approval: approved.approval, writes: [], ok: true });
    }
    if (path === `${base}/asks/ask-7/answer` && req.method() === 'POST') {
      asks = [];
      return json({ ask: { ...ASK, status: 'answered', answeredBy: body.by, answer: body, writes: [] }, plan: {}, ok: true, node: null });
    }
    if (path === `${base}/nodes/blocked/unblock` && req.method() === 'POST') {
      const unblocked = { ...nodes.get('blocked')!, blockedReason: null };
      nodes.set('blocked', unblocked);
      return json({ node: unblocked, statusReset: false });
    }
    const one = path.match(new RegExp(`^${base}/nodes/([^/]+)$`));
    if (one && nodes.has(one[1])) return json(nodes.get(one[1]));
    return json({ error: { code: 'NOT_FOUND', message: 'not in this test' } }, 404);
  });
  return { calls, socket: () => socket };
}

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => {
    const doc = document.scrollingElement!;
    const wide = [...document.querySelectorAll<HTMLElement>('[data-testid="needs-you"], [data-testid="needs-you"] *')].filter(
      (el) => el.getBoundingClientRect().right > window.innerWidth + 1,
    );
    return { page: doc.scrollWidth - doc.clientWidth, wide: wide.map((el) => el.outerHTML.slice(0, 80)) };
  });
  expect(overflow).toEqual({ page: 0, wide: [] });
}

test.describe('desktop', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('approve from the detail view; the badge goes without a reload', async ({ page }) => {
    const server = await serve(page);
    await page.goto('/e2e/harness.html?shell=desktop');
    const card = page.locator('div[draggable="true"]', { hasText: APPROVE.text });
    await expect(card).toContainText('Needs you');
    await card.click();
    const section = page.getByTestId('needs-you');
    await expect(section.getByText('Edit & approve')).toBeVisible();
    await expect(section.getByText('Reject')).toBeVisible();
    await expect(section.getByText(/from github:octo · outside/)).toBeVisible();
    await expect(section.getByTestId('approval-hints')).toContainText('Read twice');
    await section.getByTestId('approve').click();
    await expect(section.getByTestId('needs-you-decided')).toContainText('Approved');
    expect(server.calls.find((c) => c.path.endsWith('/approve'))?.body).toEqual({ merge: 'pr-only', expectedRevision: 3 });

    // The server's broadcast, as announceApproval sends it.
    const approved = { ...APPROVE, approval: { state: 'approved', merge: 'pr-only', by: 'u1', at: new Date().toISOString() } };
    server.socket()!.send(JSON.stringify({ type: 'node:updated', nodeId: 'approve', fields: ['approval'], node: approved }));
    server.socket()!.send(JSON.stringify({ type: 'asks:updated', kind: 'approval', nodeId: 'approve' }));
    await expect(card).not.toContainText('Needs you');
  });

  test('answer an open question from the detail view', async ({ page }) => {
    const server = await serve(page);
    await page.goto('/e2e/harness.html?shell=desktop');
    await page.locator('div[draggable="true"]', { hasText: 'Pick a chart library' }).click();
    const q = page.getByTestId('needs-you-question');
    await expect(q).toContainText('Recharts or visx?');
    await q.getByRole('button', { name: 'Recharts' }).click();
    await q.getByRole('button', { name: 'Answer', exact: true }).click();
    await expect(q).toContainText('answered (Dan)');
    expect(server.calls.find((c) => c.path.endsWith('/asks/ask-7/answer'))?.body).toMatchObject({ action: 'answered', decision: 'Recharts', by: 'Dan' });
  });

  test('a card with nothing waiting shows no section', async ({ page }) => {
    await serve(page);
    await page.goto('/e2e/harness.html?shell=desktop');
    await page.locator('div[draggable="true"]', { hasText: 'Nothing waits here' }).click();
    await expect(page.getByPlaceholder('Node title')).toHaveValue('Nothing waits here');
    await expect(page.getByTestId('needs-you')).toHaveCount(0);
  });
});

test.describe('phone (390 px)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('unblock a blocked card from the sheet', async ({ page }) => {
    const server = await serve(page);
    await page.goto('/e2e/harness.html?shell=phone&view=kanban');
    await page.locator('.mb-kanban-card', { hasText: BLOCKED.text }).click();
    const section = page.getByTestId('needs-you');
    await expect(section).toContainText('Needs the staging token');
    await noHorizontalScroll(page);
    await section.getByTestId('needs-you-unblock').click();
    await expect(page.getByTestId('needs-you')).toHaveCount(0);
    expect(server.calls.some((c) => c.method === 'POST' && c.path.endsWith('/nodes/blocked/unblock'))).toBe(true);
  });

  test('approve a card from the sheet, at 390 px without horizontal scroll', async ({ page }) => {
    await serve(page);
    await page.goto('/e2e/harness.html?shell=phone&view=kanban');
    await page.locator('.mb-kanban-card', { hasText: APPROVE.text }).click();
    const section = page.getByTestId('needs-you');
    await expect(section.getByTestId('approve')).toBeVisible();
    await noHorizontalScroll(page);
    await section.getByText('Reject').click();
    await noHorizontalScroll(page);
    await section.getByText('Cancel').click();
    await section.getByTestId('approve').click();
    await expect(section.getByTestId('needs-you-decided')).toContainText('Approved');
  });

  test('an open question at 390 px without horizontal scroll', async ({ page }) => {
    await serve(page);
    await page.goto('/e2e/harness.html?shell=phone&view=kanban');
    await page.locator('.mb-kanban-card', { hasText: 'Pick a chart library' }).click();
    await expect(page.getByTestId('needs-you-question')).toContainText('Recharts or visx?');
    await noHorizontalScroll(page);
  });
});
