import { describe, it, expect } from 'vitest';
import { forgeLabel, isForgeLink } from '../index.js';

describe('forgeLabel', () => {
  it('names Gitea links and maps "Gitea"', () => {
    expect(forgeLabel('gitea')).toBe('Gitea');
  });
  it('names GitHub "GitHub" and falls back to it while the kind is unknown', () => {
    expect(forgeLabel('github')).toBe('GitHub');
    expect(forgeLabel(undefined)).toBe('GitHub');
    expect(forgeLabel(null)).toBe('GitHub');
  });
  it('agrees with isForgeLink about what a forge link is', () => {
    for (const provider of ['github', 'gitea']) {
      expect(isForgeLink({ provider })).toBe(true);
      expect(['GitHub', 'Gitea']).toContain(forgeLabel(provider));
    }
    expect(isForgeLink({ provider: 'jira' })).toBe(false);
  });
});
