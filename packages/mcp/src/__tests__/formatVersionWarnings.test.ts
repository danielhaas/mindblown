import { describe, it, expect } from 'vitest';
import { formatVersionWarnings } from '../formatters.js';

describe('formatVersionWarnings (#331)', () => {
  it('is empty when there is nothing to warn about', () => {
    expect(formatVersionWarnings(undefined)).toBe('');
    expect(formatVersionWarnings([])).toBe('');
  });

  it('renders one ⚠ line per warning plus the forecast consequence', () => {
    const text = formatVersionWarnings([
      '"V1.5" (2026-09-28) is dated before "V1" (2026-12-18) but sorts after it (by name, "V1.5" > "V1")',
    ]);
    expect(text).toContain('⚠ Order warning: "V1.5" (2026-09-28) is dated before "V1" (2026-12-18)');
    expect(text).toContain('forecast chains releases in target-date order');
    expect(text.startsWith('\n')).toBe(true);
  });
});
