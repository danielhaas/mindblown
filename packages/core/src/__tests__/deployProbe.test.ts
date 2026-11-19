import { describe, expect, it } from 'vitest';
import {
  DEPLOY_PROBE_NONE,
  buildDeployProbeAsk,
  deployProbeAskId,
  deployProbeAskMapId,
  deployProbeFromAnswer,
  derivedAnswerPreview,
  isDerivedAsk,
  isProbeUrl,
  normalizeDeployProbe,
  notLiveLabel,
  parseProbeBody,
} from '../index.js';

const SHA = '3ef0712aabbccddeeff00112233445566778899a';

describe('parseProbeBody', () => {
  it('reads JSON {"commit"} (or "sha"), a JSON string, and the plain sha', () => {
    expect(parseProbeBody(`{"commit": "${SHA}", "builtAt": "x"}`)).toBe(SHA);
    expect(parseProbeBody(`{"sha":"${SHA.toUpperCase()}"}`)).toBe(SHA);
    expect(parseProbeBody(`"3ef0712"`)).toBe('3ef0712');
    expect(parseProbeBody(`${SHA}\n`)).toBe(SHA);
    expect(parseProbeBody(`3ef0712 2026-11-19`)).toBe('3ef0712');
  });

  it('anything without a commit is null', () => {
    expect(parseProbeBody('')).toBeNull();
    expect(parseProbeBody('<html>Not Found</html>')).toBeNull();
    expect(parseProbeBody('{"version": "1.2.3"}')).toBeNull();
    expect(parseProbeBody('{"commit": "not-a-sha"}')).toBeNull();
    expect(parseProbeBody('{broken')).toBeNull();
    expect(parseProbeBody('abc')).toBeNull();
  });
});

describe('normalizeDeployProbe', () => {
  it('URL, none, empty = unset', () => {
    expect(normalizeDeployProbe('https://navy.example/api/version')).toEqual({ value: 'https://navy.example/api/version' });
    expect(normalizeDeployProbe(' NONE ')).toEqual({ value: DEPLOY_PROBE_NONE });
    expect(normalizeDeployProbe('')).toEqual({ value: null });
    expect(normalizeDeployProbe(null)).toEqual({ value: null });
  });

  it('refuses what is not a http(s) URL', () => {
    expect(normalizeDeployProbe('navy')).toHaveProperty('error');
    expect(normalizeDeployProbe('file:///etc/passwd')).toHaveProperty('error');
    expect(normalizeDeployProbe(42)).toHaveProperty('error');
  });

  it('isProbeUrl: only a URL is read', () => {
    expect(isProbeUrl('https://x/version.txt')).toBe(true);
    expect(isProbeUrl(DEPLOY_PROBE_NONE)).toBe(false);
    expect(isProbeUrl(null)).toBe(false);
  });
});

describe('notLiveLabel', () => {
  it('"2 merges not live on Navy for 19 h"', () => {
    const now = new Date('2026-11-19T12:00:00Z');
    expect(notLiveLabel(2, 'Navy', '2026-11-18T17:00:00Z', now)).toBe('2 merges not live on Navy for 19 h');
    expect(notLiveLabel(1, 'Navy', '2026-11-19T11:30:00Z', now)).toBe('1 merge not live on Navy for under an hour');
    expect(notLiveLabel(3, 'Navy', '2026-11-16T12:00:00Z', now)).toBe('3 merges not live on Navy for 3 days');
  });
});

describe('the setup question', () => {
  const ask = buildDeployProbeAsk({ id: 'map-1', name: 'Navy' }, 'Dan');

  it('is a derived decision about the map, no node', () => {
    expect(ask.id).toBe(deployProbeAskId('map-1'));
    expect(deployProbeAskMapId(ask.id)).toBe('map-1');
    expect(deployProbeAskMapId('step-x')).toBeNull();
    expect(isDerivedAsk(ask)).toBe(true);
    expect(ask.hint).toBe('decision');
    expect(ask.unblocks.node_id).toBeNull();
    expect(ask.title).toBe('How is Navy deployed?');
  });

  it('an answer is a URL or none; other text sets nothing', () => {
    expect(deployProbeFromAnswer('https://navy.example/api/version')).toBe('https://navy.example/api/version');
    expect(deployProbeFromAnswer('probe is https://navy.example/version.txt please')).toBe('https://navy.example/version.txt');
    expect(deployProbeFromAnswer('none')).toBe(DEPLOY_PROBE_NONE);
    expect(deployProbeFromAnswer('None — not deployed')).toBe(DEPLOY_PROBE_NONE);
    expect(deployProbeFromAnswer('by hand on gamora')).toBeNull();
  });

  it('previews what the answer writes', () => {
    expect(derivedAnswerPreview(ask, 'none')?.[0]).toContain('"none"');
    expect(derivedAnswerPreview(ask, 'https://x/v')?.[0]).toContain('https://x/v');
    expect(derivedAnswerPreview(ask, 'later maybe')?.[0]).toContain('probe URL');
  });
});
