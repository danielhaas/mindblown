import { describe, it, expect } from 'vitest';
import { ApiError } from '../api.js';
import { authErrorMessage } from '../authError.js';

describe('authErrorMessage', () => {
  it('turns a fetch network failure into an unreachable-server message', () => {
    for (const msg of ['Failed to fetch', 'NetworkError when attempting to fetch resource.', 'Load failed']) {
      expect(authErrorMessage(new TypeError(msg))).toMatch(/Can't reach the MindBlown server/);
    }
  });

  it('keeps the server message for API errors', () => {
    const err = new ApiError(401, 'Invalid email or password', 'INVALID_CREDENTIALS');
    expect(authErrorMessage(err)).toBe('Invalid email or password');
  });

  it('falls back for errors without a message', () => {
    expect(authErrorMessage(new Error(''))).toBe('Something went wrong');
    expect(authErrorMessage('boom')).toBe('Something went wrong');
  });
});
