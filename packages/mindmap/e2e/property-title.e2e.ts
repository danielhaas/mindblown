/**
 * The detail panel shows a long ticket title in full: it wraps onto more
 * lines instead of being cut at the panel edge. Still one line of data —
 * Enter commits, it never adds a newline.
 */
import { expect, test, type Page } from '@playwright/test';
import { makeNode, MAP_ID, WORKFLOW } from '../src/__tests__/needsYouFixtures.js';

const LONG =
  'Gitea PR merge: node.pr_merged never recorded — fleet journal reports "no PR on record" for delivered tickets (repro in the issue)';
const NODES = [
  makeNode('root', { parentId: null, text: 'Project', childrenIds: ['long'] }),
  makeNode('long', { text: LONG }),
].map((n) => ({ ...n, computedEffort: 0, computedProgress: 0, healthSignal: 'on_track', actualEffort: null }));

const MAP = {
  id: MAP_ID, workspaceId: 'w1', name: 'Project', description: null, rootNodeId: 'root',
  effortUnit: 'days', statusWorkflow: WORKFLOW, customFieldDefs: [], defaultLayout: 'tree',
  healthThreshold: 0.2, phases: [], baselines: [], wipLimit: null, fleetId: null,
  computedProgress: 0, healthSignal: 'on_track',
};

async function open(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.routeWebSocket(/\/ws\//, () => {});
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === `/api/maps/${MAP_ID}`) {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ map: MAP, nodes: NODES }) });
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":{"code":"NOT_FOUND"}}' });
  });
  await page.goto('/e2e/harness.html?shell=desktop');
  // loadMap clears the selection — select only once the board is up.
  await expect(page.getByText(LONG).first()).toBeVisible();
  await page.evaluate(() => (window as never as { __store: { getState(): { selectNode(id: string): void } } }).__store.getState().selectNode('long'));
}

for (const width of [1440, 1024]) {
  test(`a long title wraps in full in the detail panel (${width}px)`, async ({ page }) => {
    await open(page, width);
    const title = page.getByTestId('node-title');
    await expect(title).toHaveValue(LONG);
    const m = await title.evaluate((el: HTMLTextAreaElement) => ({
      client: el.clientHeight,
      scroll: el.scrollHeight,
      scrollW: el.scrollWidth,
      clientW: el.clientWidth,
      line: parseFloat(getComputedStyle(el).lineHeight),
    }));
    expect(m.scroll, 'nothing hidden vertically').toBeLessThanOrEqual(m.client + 1);
    expect(m.scrollW, 'nothing cut horizontally').toBeLessThanOrEqual(m.clientW + 1);
    expect(m.client, 'more than one line').toBeGreaterThan(m.line * 1.5);
  });
}

test('Enter commits without adding a newline', async ({ page }) => {
  await open(page, 1440);
  const title = page.getByTestId('node-title');
  await title.click();
  await title.press('End');
  await title.press('Enter');
  await expect(title).toHaveValue(LONG);
  await expect(title).not.toBeFocused();
});
