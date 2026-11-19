import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { buildInfo } from '../buildInfo.js';

describe('buildInfo', () => {
  it('is the checkout HEAD, read once', async () => {
    const head = execFileSync('git', ['rev-parse', 'HEAD']).toString().trim();
    const a = await buildInfo();
    expect(a.commit).toBe(head);
    expect(Number.isNaN(Date.parse(a.builtAt))).toBe(false);
    expect(await buildInfo()).toBe(a);
  });
});
