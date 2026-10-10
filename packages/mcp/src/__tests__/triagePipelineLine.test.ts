import { describe, it, expect } from 'vitest';
import { triagePipelineLine } from '../formatters.js';

describe('triagePipelineLine (#320)', () => {
  it('one line with since, cause and count when broken; nothing when healthy or unknown', () => {
    expect(
      triagePipelineLine({ broken: true, count: 266, cause: 'Your credit balance is too low', since: '2026-08-21T03:00:00Z' }),
    ).toBe('🔴 **Triage pipeline broken since 2026-08-21**: Your credit balance is too low — 266 ticket(s) untriaged');
    expect(triagePipelineLine({ broken: false, count: 0, cause: null, since: null })).toBeNull();
    expect(triagePipelineLine(null)).toBeNull();
  });
});
