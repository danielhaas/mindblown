/**
 * The mindmap's "+N" pill (children hidden by the depth limit) and "+"
 * circle (branch folded by hand) open what they hide when clicked where
 * a person clicks: at their on-screen position, through whatever is drawn
 * on top. The harness renders the real MindmapEditor; this file plays
 * the server.
 */
import { expect, test, type Page } from '@playwright/test';
import { makeNode, MAP_ID, WORKFLOW } from '../src/__tests__/needsYouFixtures.js';

const NODES = [
  makeNode('root', { parentId: null, text: 'Project', childrenIds: ['area', 'folded'] }),
  makeNode('area', { text: 'Billing', childrenIds: ['task'] }),
  makeNode('task', { parentId: 'area', text: 'Invoices', childrenIds: ['leaf'] }),
  makeNode('leaf', { parentId: 'task', text: 'PDF layout' }),
  makeNode('folded', { text: 'Auth', childrenIds: ['login'], collapsed: true }),
  makeNode('login', { parentId: 'folded', text: 'Login form' }),
].map((n) => ({ ...n, computedEffort: 0, computedProgress: 0, healthSignal: 'on_track', actualEffort: null }));

const MAP = {
  id: MAP_ID, workspaceId: 'w1', name: 'Project', description: null, rootNodeId: 'root',
  effortUnit: 'days', statusWorkflow: WORKFLOW, customFieldDefs: [], defaultLayout: 'tree',
  healthThreshold: 0.2, phases: [], baselines: [], wipLimit: null, fleetId: null,
  computedProgress: 0, healthSignal: 'on_track',
};

async function open(page: Page) {
  await page.routeWebSocket(/\/ws\//, () => {});
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === `/api/maps/${MAP_ID}`) {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ map: MAP, nodes: NODES }) });
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":{"code":"NOT_FOUND"}}' });
  });
  await page.goto('/e2e/harness.html?shell=mindmap');
  await expect(page.getByText('Billing', { exact: true })).toBeVisible();
}

const state = (page: Page) =>
  page.evaluate(() => {
    const s = (window as never as { __store: { getState(): Record<string, unknown> } }).__store.getState();
    return { focus: s.focusNodeId, selected: s.selectedNodeId, maxDepth: s.maxDepth };
  });

/** The "+N" pill on the row of the node labelled `label`. */
async function pillFor(page: Page, label: string) {
  const row = (await page.getByText(label, { exact: true }).boundingBox())!;
  const pills = page.getByTestId('node-show-hidden');
  const n = await pills.count();
  for (let i = 0; i < n; i++) {
    const box = (await pills.nth(i).boundingBox())!;
    if (Math.abs(box.y + box.height / 2 - (row.y + row.height / 2)) < 8) return box;
  }
  throw new Error(`no pill next to ${label}`);
}

/** Click a box's centre by screen position — hits whatever is drawn on top there. */
const clickBox = (page: Page, box: { x: number; y: number; width: number; height: number }) =>
  page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

test('"+N" pill drills into the node and shows what was hidden', async ({ page }) => {
  await open(page);
  expect((await state(page)).maxDepth).toBe(1);
  await expect(page.getByText('Invoices', { exact: true })).toHaveCount(0);

  await clickBox(page, await pillFor(page, 'Billing'));

  expect((await state(page)).focus).toBe('area');
  await expect(page.getByText('Invoices', { exact: true })).toBeVisible();
});

test('"+N" pill on a folded node unfolds it on the way in', async ({ page }) => {
  await open(page);
  await clickBox(page, await pillFor(page, 'Auth'));

  expect((await state(page)).focus).toBe('folded');
  await expect(page.getByText('Login form', { exact: true })).toBeVisible();
});

test('"+" circle unfolds a folded branch in place, without selecting it', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: '2', exact: true }).click();
  await expect(page.getByText('Login form', { exact: true })).toHaveCount(0);

  await clickBox(page, (await page.getByTestId('node-expand').boundingBox())!);

  await expect(page.getByText('Login form', { exact: true })).toBeVisible();
  const s = await state(page);
  expect(s.focus).toBeNull();
  expect(s.selected).not.toBe('folded');
});
