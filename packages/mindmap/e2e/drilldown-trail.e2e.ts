/**
 * Drilled into a node, the mindmap shows the way back: the node's
 * ancestors, root first, left of it — not its siblings, which used to sit
 * there and read as its parents. Clicking one goes back up to it.
 */
import { expect, test, type Page } from '@playwright/test';
import { makeNode, MAP_ID, WORKFLOW } from '../src/__tests__/needsYouFixtures.js';

const AREAS = ['M0 Setup', 'M1 Billing', 'M2 Auth'];
const NODES = [
  makeNode('root', { parentId: null, text: 'Loke-Support', childrenIds: AREAS.map((_, i) => `a${i}`) }),
  ...AREAS.map((t, i) => makeNode(`a${i}`, { text: t, childrenIds: [`a${i}-t1`, `a${i}-t2`] })),
  ...AREAS.flatMap((t, i) => [1, 2].map((k) => makeNode(`a${i}-t${k}`, { parentId: `a${i}`, text: `${t} task ${k}`, childrenIds: [`a${i}-t${k}-l`] }))),
  ...AREAS.flatMap((t, i) => [1, 2].map((k) => makeNode(`a${i}-t${k}-l`, { parentId: `a${i}-t${k}`, text: `${t} task ${k} leaf` }))),
].map((n) => ({ ...n, computedEffort: 0, computedProgress: 0, healthSignal: 'on_track', actualEffort: null }));

const MAP = {
  id: MAP_ID, workspaceId: 'w1', name: 'Project', description: null, rootNodeId: 'root',
  effortUnit: 'days', statusWorkflow: WORKFLOW, customFieldDefs: [], defaultLayout: 'tree',
  healthThreshold: 0.2, phases: [], baselines: [], wipLimit: null, fleetId: null,
  computedProgress: 0, healthSignal: 'on_track',
};

async function open(page: Page) {
  await page.routeWebSocket(/\/ws\//, () => {});
  await page.route('**/api/**', (route) =>
    new URL(route.request().url()).pathname === `/api/maps/${MAP_ID}`
      ? route.fulfill({ contentType: 'application/json', body: JSON.stringify({ map: MAP, nodes: NODES }) })
      : route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":{"code":"NOT_FOUND"}}' }),
  );
  await page.goto('/e2e/harness.html?shell=mindmap');
  await expect(page.getByText('M1 Billing', { exact: true })).toBeVisible();
}

const focus = (page: Page) =>
  page.evaluate(() => (window as never as { __store: { getState(): { focusNodeId: string | null } } }).__store.getState().focusNodeId);
const box = async (page: Page, text: string) => (await page.getByText(text, { exact: true }).boundingBox())!;
const centre = (b: { x: number; y: number; width: number; height: number }) => [b.x + b.width / 2, b.y + b.height / 2] as const;

test('drilled two levels in: root → parent trail on the left, no siblings; clicks walk back up', async ({ page }) => {
  await open(page);
  await page.mouse.dblclick(...centre(await box(page, 'M1 Billing')));
  await page.mouse.dblclick(...centre(await box(page, 'M1 Billing task 2')));
  expect(await focus(page)).toBe('a1-t2');

  // The way back, in order, level with the focus node.
  const [root, parent, here] = [await box(page, 'Loke-Support'), await box(page, 'M1 Billing'), await box(page, 'M1 Billing task 2')];
  expect(root.x).toBeLessThan(parent.x);
  expect(parent.x).toBeLessThan(here.x);
  expect(Math.abs(centre(parent)[1] - centre(here)[1])).toBeLessThan(2);
  // Siblings at any level are gone.
  for (const sibling of ['M1 Billing task 1', 'M0 Setup', 'M2 Auth']) {
    await expect(page.getByText(sibling, { exact: true })).toHaveCount(0);
  }

  await page.mouse.click(...centre(parent));
  expect(await focus(page)).toBe('a1');
  await expect(page.getByText('M1 Billing task 1', { exact: true })).toBeVisible();

  await page.mouse.click(...centre(await box(page, 'Loke-Support')));
  expect(await focus(page)).toBeNull();
  await expect(page.getByText('M2 Auth', { exact: true })).toBeVisible();
});

test('the trail is navigation only: no context menu, ArrowLeft stops at the focus node', async ({ page }) => {
  await open(page);
  const state = () =>
    page.evaluate(() => {
      const s = (window as never as { __store: { getState(): { focusNodeId: string | null; selectedNodeId: string | null } } }).__store.getState();
      return { focus: s.focusNodeId, selected: s.selectedNodeId };
    });
  await page.evaluate(() => (window as never as { __store: { setState(s: object): void } }).__store.setState({ focusNodeId: 'a1-t2' }));
  const parent = await box(page, 'M1 Billing');

  await page.mouse.click(...centre(parent), { button: 'right' });
  await expect(page.getByText('Delete', { exact: true })).toHaveCount(0);
  expect(await state()).toEqual({ focus: 'a1-t2', selected: null });

  await page.mouse.click(...centre(await box(page, 'M1 Billing task 2')));
  expect((await state()).selected).toBe('a1-t2');
  await page.keyboard.press('ArrowLeft');
  expect(await state()).toEqual({ focus: 'a1-t2', selected: 'a1-t2' });
});

test('top-down layouts stack the trail above', async ({ page }) => {
  await open(page);
  await page.evaluate(() =>
    (window as never as { __store: { setState(s: object): void } }).__store.setState({ layoutType: 'org-chart', focusNodeId: 'a1-t2' }),
  );
  const [root, parent, here] = [await box(page, 'Loke-Support'), await box(page, 'M1 Billing'), await box(page, 'M1 Billing task 2')];
  expect(root.y).toBeLessThan(parent.y);
  expect(parent.y).toBeLessThan(here.y);
});
