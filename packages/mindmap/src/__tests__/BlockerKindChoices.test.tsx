// @vitest-environment jsdom
/**
 * The Block choices: the four kinds under the blocker text, each one a
 * flag-blocker POST with its kind; a kinded blocker says where it went.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { makeNode } from './needsYouFixtures.js';
import { useMindmapStore } from '../store.js';
import { BlockerKindChoices, blockerKindNote } from '../BlockerKindChoices.js';

afterEach(cleanup);

const node = makeNode('a', { text: 'Payment page', blockedReason: 'Stripe or Adyen?' });
const other = makeNode('b', { text: 'Merge the API PR' });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  useMindmapStore.setState({ currentMapId: 'm1', nodes: { a: node, b: other }, error: null } as never);
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ node, kind: 'question' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
});

const sent = () => {
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  return { url, body: JSON.parse(String(init.body)) };
};

describe('BlockerKindChoices', () => {
  it('offers the four choices and sends the picked kind with the text', async () => {
    render(<BlockerKindChoices node={node} reason="Stripe or Adyen?" />);
    for (const k of ['question', 'person-step', 'external', 'waits-on']) expect(screen.getByTestId(`blocker-kind-${k}`)).toBeTruthy();
    fireEvent.click(screen.getByTestId('blocker-kind-question'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(sent().url).toContain('/api/maps/m1/nodes/a/flag-blocker');
    expect(sent().body).toEqual({ kind: 'question', reason: 'Stripe or Adyen?' });
  });

  it('waits on a ticket: pick it, a dependency is asked for', async () => {
    render(<BlockerKindChoices node={node} reason="after the API PR" />);
    fireEvent.click(screen.getByTestId('blocker-kind-waits-on'));
    fireEvent.change(screen.getByTestId('blocker-kind-waits-on-target'), { target: { value: 'b' } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(sent().body).toEqual({ kind: 'waits-on', reason: 'after the API PR', waitsOn: 'b' });
  });

  it('a kinded blocker says where it went instead', () => {
    const asked = { ...node, blockerInfo: { kind: 'question' as const, answerer: 'Dan' } };
    render(<BlockerKindChoices node={asked} reason="Stripe or Adyen?" />);
    expect(screen.getByTestId('blocker-kind-note').textContent).toBe('A question for Dan — on the Questions card.');
    expect(screen.queryByTestId('blocker-kind-choices')).toBeNull();
    expect(blockerKindNote({ blockedReason: 'LOKE', blockerInfo: { kind: 'external', recheckAt: '2026-11-26T08:00:00Z' } })).toBe('Waiting on a party outside — asked again on 2026-11-26.');
  });

  it('nothing without text', () => {
    const { container } = render(<BlockerKindChoices node={{ ...node, blockedReason: null }} reason="" />);
    expect(container.textContent).toBe('');
  });
});
